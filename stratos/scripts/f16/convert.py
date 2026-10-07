"""
FlightGear (XML + AC3D) cockpit -> single GLB for STRATOS.

- Walks the <model> include tree from a root XML, applying FlightGear offset
  transforms (rotate pitch(y) -> roll(x) -> heading(z), then translate), in the
  FlightGear model frame (x aft, y right, z up). AC3D files are y-up and map to
  that frame as (x, -z, y).
- Converts the final positions to the STRATOS body frame
  (x right, y up, z aft): ours = (fg_y, fg_z + DY, fg_x + DZ).
- Smooth normals honour the AC3D crease angle; polygons are fan-triangulated;
  line surfaces are skipped.
- Geometry is merged per (material, texture, two-sided, transparent) so the
  whole cockpit costs a few dozen draw calls.
- Textures are converted to PNG (alpha) or JPEG and downscaled.
- Writes report.json with every named object (submodel, name, bbox) so the
  game can anchor its HUD / MFD / interactive hotspots on the real parts.
"""
import json, math, os, re, struct, sys, io, posixpath, hashlib
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image

ROOT = sys.argv[1]           # downloaded repo mirror dir
ROOT_XML = sys.argv[2]       # e.g. Models/Cockpit/Main/cockpit.xml
OUT = sys.argv[3]            # output dir
SKIP = set(sys.argv[4].split(',')) if len(sys.argv) > 4 and sys.argv[4] else set()
DROP_OBJECTS = set(sys.argv[5].split(',')) if len(sys.argv) > 5 and sys.argv[5] else set()
# FlightGear eye point (x -4.105, z 0.8579) -> our eye point (0, 0.96, -4.2); the
# cockpit sits LIFT higher so the HUD boresight falls inside the combiner glass
LIFT = float(os.environ.get("LIFT", "0.035"))
DY, DZ = 0.96 - 0.8579 + LIFT, -4.2 - (-4.1050)
MAXTEX = int(os.environ.get('MAXTEX', '1024'))

def repo_path(p, base):
    p = p.strip()
    if p.startswith('Aircraft/f16/'): return p[len('Aircraft/f16/'):]
    if p.startswith('/Aircraft/') or p.startswith('Aircraft/'): return 'fgdata/' + p.lstrip('/')  # shared FGData parts
    if base.startswith('fgdata/') and not p.startswith('/'): return posixpath.normpath(posixpath.join(posixpath.dirname(base), p))
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), p))

def rot(axis, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    x, y, z = axis
    return np.array([[c + x*x*(1-c), x*y*(1-c) - z*s, x*z*(1-c) + y*s],
                     [y*x*(1-c) + z*s, c + y*y*(1-c), y*z*(1-c) - x*s],
                     [z*x*(1-c) - y*s, z*y*(1-c) + x*s, c + z*z*(1-c)]])

def offsets_matrix(off):
    """4x4 (column-vector) matrix for a FlightGear <offsets> block."""
    M = np.eye(4)
    if off is None: return M
    g = lambda k: float(off.findtext(k) or 0)
    # OSG row-vector R = Rpitch * Rroll * Rheading  ==> column form: H * Ro * P
    R = rot((0, 0, 1), g('heading-deg')) @ rot((1, 0, 0), g('roll-deg')) @ rot((0, 1, 0), g('pitch-deg'))
    M[:3, :3] = R
    M[:3, 3] = [g('x-m'), g('y-m'), g('z-m')]
    return M

# ----------------------------------------------------------------------------- AC3D
def parse_ac(path):
    lines = open(path, errors='ignore').read().splitlines()
    i = 0
    mats = []
    objs = []  # flat list of polys with world-ish transform applied (AC object space)
    def next_line():
        nonlocal i
        while i < len(lines) and not lines[i].strip(): i += 1
        l = lines[i]; i += 1; return l
    assert next_line().startswith('AC3D')
    def read_object(parentM, ancestors):
        nonlocal i
        hdr = next_line().split()
        assert hdr[0] == 'OBJECT', hdr
        o = {'type': hdr[1], 'name': '', 'texture': None, 'texrep': (1, 1), 'texoff': (0, 0), 'crease': 61.0,
             'rot': np.eye(3), 'loc': np.zeros(3), 'verts': None, 'surfs': []}
        while True:
            l = next_line(); tok = l.split()
            k = tok[0]
            if k == 'name': o['name'] = l.split('"')[1] if '"' in l else tok[1]
            elif k == 'data':
                n = int(tok[1]); s = ''
                while len(s) < n: s += next_line() + '\n'
            elif k == 'texture': o['texture'] = l.split('"')[1]
            elif k == 'texrep': o['texrep'] = (float(tok[1]), float(tok[2]))
            elif k == 'texoff': o['texoff'] = (float(tok[1]), float(tok[2]))
            elif k == 'rot': o['rot'] = np.array([float(x) for x in tok[1:10]]).reshape(3, 3)
            elif k == 'loc': o['loc'] = np.array([float(x) for x in tok[1:4]])
            elif k == 'crease': o['crease'] = float(tok[1])
            elif k == 'url': pass
            elif k == 'numvert':
                n = int(tok[1])
                o['verts'] = np.array([[float(x) for x in next_line().split()[:3]] for _ in range(n)]) if n else np.zeros((0, 3))
            elif k == 'numsurf':
                n = int(tok[1])
                for _ in range(n):
                    f = next_line().split(); flags = int(f[1], 0)
                    m = next_line().split(); mat = int(m[1])
                    r = next_line().split(); nr = int(r[1])
                    refs = []
                    for _ in range(nr):
                        rr = next_line().split(); refs.append((int(rr[0]), float(rr[1]), float(rr[2])))
                    o['surfs'].append((flags, mat, refs))
            elif k == 'kids':
                nk = int(tok[1])
                # AC3D: object transform = translate(loc) * rot (rows are basis)
                L = np.eye(4); L[:3, :3] = o['rot'].T; L[:3, 3] = o['loc']
                M = parentM @ L
                o['M'] = M
                o['ancestors'] = ancestors + [o['name']]
                if o['type'] == 'poly' and o['verts'] is not None and len(o['surfs']): objs.append(o)
                for _ in range(nk):
                    # some files declare more kids than they contain (FG tolerates it)
                    if not any(l.strip() for l in lines[i:i + 3]): break
                    read_object(M, o['ancestors'])
                return
            elif k == 'MATERIAL': pass
    while i < len(lines):
        l = lines[i]
        if l.startswith('MATERIAL'):
            name = l.split('"')[1]
            nums = re.findall(r'(rgb|amb|emis|spec|shi|trans)\s+([-\d. ]+)', l)
            d = {k: [float(x) for x in v.split()] for k, v in nums}
            mats.append({'name': name, **d}); i += 1
        elif l.startswith('OBJECT'):
            read_object(np.eye(4), [])
        else: i += 1
    return mats, objs

AC2FG = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float)  # (x,y,z)_ac -> (x,-z,y)_fg
FG2OURS = np.array([[0, 1, 0, 0], [0, 0, 1, DY], [1, 0, 0, DZ], [0, 0, 0, 1]], dtype=float)


# ----------------------------------------------------------------------------- select animations
# FlightGear shows/hides parts with <animation><type>select</type> + <condition>.
# Evaluate them for one fixed configuration (F-16C Block 50, cold & dark,
# gear down, viewed from the cockpit); unknown properties read as 0 / false,
# which keeps every lamp, flag and optional store unlit or hidden.
PROPS = {
    'sim/variant-id': 5, 'sim/multiplay/generic/int[9]': 5,
    'sim/variant-engine': 0, 'sim/multiplay/generic/int[10]': 0,
    'f16/avionics/hud-basic': 0,
    'sim/current-view/internal': 1, 'sim/current-view/name': 'Cockpit View',
    'systems/static/serviceable': 1, 'systems/pitot/serviceable': 1,
    'gear/gear[0]/position-norm': 1, 'gear/gear[1]/position-norm': 1, 'gear/gear[2]/position-norm': 1,
    'controls/gear/gear-down': 1,
    # instruments powered: no OFF flags, tapes visible
    'fdm/jsbsim/elec/bus/emergency-ac-1': 115, 'fdm/jsbsim/elec/bus/emergency-ac-2': 115,
    'fdm/jsbsim/elec/bus/emergency-dc-1': 28, 'fdm/jsbsim/elec/bus/batt-1': 28, 'fdm/jsbsim/elec/bus/batt-2': 28,
    'fdm/jsbsim/elec/sources/batt-bus': 28,
}
PROPS.update(json.loads(os.environ.get('PROPS', '{}')))

def prop(name):
    return PROPS.get(name.strip().lstrip('/'), 0)

def operand(e):
    if e.tag == 'property': return prop(e.text or '')
    t = (e.text or '').strip()
    try: return float(t)
    except ValueError: return t

def cmp_args(e):
    a = [operand(c) for c in e if c.tag in ('property', 'value')]
    if len(a) < 2: return None
    x, y = a[0], a[1]
    if isinstance(x, str) != isinstance(y, str): x, y = str(x), str(y)
    return x, y

def cond(e):
    """Evaluates a FlightGear <condition> (children are implicitly AND-ed)."""
    return all(term(c) for c in e if isinstance(c.tag, str))

def term(e):
    t = e.tag
    if t in ('and', 'condition'): return all(term(c) for c in e if isinstance(c.tag, str))
    if t == 'or': return any(term(c) for c in e if isinstance(c.tag, str))
    if t == 'not': return not all(term(c) for c in e if isinstance(c.tag, str))
    if t == 'property': return bool(prop(e.text or ''))
    ops = {'equals': lambda a, b: a == b, 'not-equals': lambda a, b: a != b,
           'less-than': lambda a, b: a < b, 'greater-than': lambda a, b: a > b,
           'less-than-equals': lambda a, b: a <= b, 'greater-than-equals': lambda a, b: a >= b}
    if t in ops:
        ab = cmp_args(e)
        return ops[t](*ab) if ab else False
    return True  # unknown / expression terms: keep the part

def hidden_names(root):
    hide = set()
    for a in root.findall('animation'):
        if (a.findtext('type') or '').strip() != 'select': continue
        c = a.find('condition')
        if c is None or cond(c): continue
        for n in a.findall('object-name'): hide.add((n.text or '').strip())
    return hide

# ----------------------------------------------------------------------------- dynamic parts
# DYN spec (JSON, argv[6]):
#   "dyn":   {"sub/name" | "name" | "sub/*": key}  -> own node "dyn:<key>" ("" = keep static)
#   "auto":  [FlightGear properties]  -> any part animated by one becomes its own node
#   "drop":  [names]                   -> geometry removed (bbox kept as anchor)
#   "anchors": [names]                 -> bbox + normal exported in the scene extras
SPEC = json.load(open(sys.argv[6])) if len(sys.argv) > 6 else {'dyn': {}, 'auto': [], 'drop': [], 'anchors': []}
DYN = SPEC.get('dyn', {})
AUTO = set(SPEC.get('auto', []))
DROP_OBJECTS |= set(SPEC.get('drop', []))
ANCHOR_NAMES = set(SPEC.get('anchors', []))

batches = {}   # key -> dict(pos, nrm, uv, mat info, dyn)
report = []
anchors = {}
dyn_info = {}  # key -> {'anims': [...], 'objects': [...]}
tex_cache = {}

def tex_key(acpath, tex):
    if not tex: return None
    p = repo_path(tex, acpath)
    return p

def fnum(e, *tags, default=None):
    for t in tags:
        v = e.findtext(t)
        if v is not None and v.strip():
            try: return float(v)
            except ValueError: pass
    return default

def parse_anims(root, M_fg):
    """rotate / translate / knob / slider / textranslate animations of one XML, in our frame"""
    out = []
    R = (FG2OURS @ M_fg)[:3, :3]
    for a in root.findall('animation'):
        ty = (a.findtext('type') or '').strip()
        if ty not in ('rotate', 'translate', 'knob', 'slider', 'textranslate'): continue
        names = set((n.text or '').strip() for n in a.findall('object-name'))
        prop_name = (a.findtext('property') or '').strip().lstrip('/')
        rec = {'type': {'knob': 'rotate', 'slider': 'translate'}.get(ty, ty), 'prop': prop_name,
               'factor': fnum(a, 'factor', default=1.0), 'offset': fnum(a, 'offset-deg', 'offset-m', 'offset', default=0.0),
               'min': fnum(a, 'min-deg', 'min-m', 'min'), 'max': fnum(a, 'max-deg', 'max-m', 'max')}
        it = a.find('interpolation')
        if it is not None:
            rec['interp'] = [[float(e.findtext('ind')), float(e.findtext('dep'))] for e in it.findall('entry')]
        ax = a.find('axis')
        c = a.find('center')
        center = np.zeros(3); axis = np.array([0.0, 0.0, 1.0])
        if c is not None: center = np.array([fnum(c, 'x-m', default=0), fnum(c, 'y-m', default=0), fnum(c, 'z-m', default=0)])
        if ax is not None:
            if ax.find('x1-m') is not None:
                p1 = np.array([fnum(ax, 'x1-m', default=0), fnum(ax, 'y1-m', default=0), fnum(ax, 'z1-m', default=0)])
                p2 = np.array([fnum(ax, 'x2-m', default=0), fnum(ax, 'y2-m', default=0), fnum(ax, 'z2-m', default=0)])
                center = (p1 + p2) / 2 if c is None else center; axis = p2 - p1
            else:
                axis = np.array([fnum(ax, 'x', default=0), fnum(ax, 'y', default=0), fnum(ax, 'z', default=0)])
        if rec['type'] == 'textranslate':
            # texture-space axis stays 2D
            rec['uv'] = [float(axis[0]), float(axis[1])]
            rec['step'] = fnum(a, 'step'); rec['scroll'] = fnum(a, 'scroll')
        else:
            n = np.linalg.norm(axis)
            rec['axis'] = (R @ (axis / n if n > 1e-9 else axis)).round(6).tolist()
            rec['center'] = (FG2OURS @ M_fg @ np.r_[center, 1])[:3].round(6).tolist()
        rec['_names'] = names
        out.append(rec)
    return out

def dyn_key(sub, o, chain):
    for k in (f"{sub}/{o['name']}", o['name'], f"{sub}/*"):
        if k in DYN: return DYN[k]
    if any(r['prop'] in AUTO for r in chain):
        sig = json.dumps([sub] + [{k: v for k, v in r.items() if k != '_names'} for r in chain], sort_keys=True)
        return 'a:' + hashlib.sha1(sig.encode()).hexdigest()[:10]
    return ''

def add_object(o, mats, acpath, M_fg, sub, hidden=frozenset(), anims=()):
    if any(n in hidden for n in o['ancestors']): return
    M = FG2OURS @ M_fg @ AC2FG @ o['M']
    V = o['verts']
    Vh = np.c_[V, np.ones(len(V))] @ M.T
    P = Vh[:, :3]
    tex = tex_key(acpath, o['texture'])
    crease = math.radians(o['crease'])
    tr, to = o['texrep'], o['texoff']
    # face list
    faces = []  # (mat, twosided, smooth, [(vi,u,v)...])
    for flags, mat, refs in o['surfs']:
        if (flags & 0xF) != 0 or len(refs) < 3: continue
        faces.append((mat, bool(flags & 0x20), bool(flags & 0x10), refs))
    if not faces: return
    # face normals (in our frame)
    fn = []; area_n = np.zeros(3)
    for mat, ts, sm, refs in faces:
        n = np.zeros(3)
        for k in range(1, len(refs) - 1):  # fan sum for robustness
            n += np.cross(P[refs[k][0]] - P[refs[0][0]], P[refs[k + 1][0]] - P[refs[0][0]])
        area_n += n
        l = np.linalg.norm(n); fn.append(n / l if l > 1e-12 else np.array([0, 1, 0.0]))
    bb_min, bb_max = P.min(0), P.max(0)
    nl = np.linalg.norm(area_n)
    entry = {'sub': sub, 'name': o['name'], 'min': bb_min.round(4).tolist(), 'max': bb_max.round(4).tolist(),
             'n': (area_n / nl).round(3).tolist() if nl > 1e-12 else [0, 0, 0], 'tex': tex, 'faces': len(faces)}
    full = f"{sub}/{o['name']}"
    if o['name'] in DROP_OBJECTS or full in DROP_OBJECTS:
        anchors[full] = entry; return
    chain = [r for r in anims if any(n in r['_names'] for n in o['ancestors'])]
    dyn = dyn_key(sub, o, chain)
    entry['dyn'] = dyn
    report.append(entry)
    if dyn or full in ANCHOR_NAMES or o['name'] in ANCHOR_NAMES or any(a.endswith('*') and o['name'].startswith(a[:-1]) for a in ANCHOR_NAMES): anchors[full] = entry
    if dyn:
        d = dyn_info.setdefault(dyn, {'anims': [], 'objects': []})
        if not d['anims']: d['anims'] = [{k: v for k, v in r.items() if k != '_names'} for r in chain]
        d['objects'].append(full)
    # vertex -> faces adjacency for smoothing
    adj = {}
    for fi, (_, _, _, refs) in enumerate(faces):
        for (vi, _, _) in refs: adj.setdefault(vi, []).append(fi)
    cosc = math.cos(crease)
    for fi, (mat, ts, sm, refs) in enumerate(faces):
        m = mats[mat] if mat < len(mats) else {'name': 'default', 'rgb': [0.8, 0.8, 0.8], 'emis': [0, 0, 0], 'spec': [0, 0, 0], 'shi': [32], 'trans': [0]}
        trans = (m.get('trans') or [0])[0]
        # merge everything sharing a texture / blend class / lighting class;
        # the AC3D diffuse colour travels as a vertex colour
        shi = (m.get('shi') or [32])[0]
        rough = round(float(np.clip(1.0 - shi / 160.0, 0.45, 0.95)), 1)
        emis = tuple(round(x, 2) for x in m.get('emis', [0, 0, 0]))
        key = (dyn, tex, ts, round(trans, 2), emis if any(e > 0.01 for e in emis) else None, rough)
        b = batches.setdefault(key, {'pos': [], 'nrm': [], 'uv': [], 'col': [], 'mat': m, 'tex': tex, 'twosided': ts, 'dyn': dyn, 'rough': rough, 'emis': emis, 'trans': trans})
        rgb = m.get('rgb', [1, 1, 1])
        col = tuple(int(round(255 * min(1.0, max(0.0, c)) ** 2.2)) for c in rgb) + (255,)
        corners = []
        for (vi, u, v) in refs:
            if sm:
                n = np.zeros(3)
                for fj in adj[vi]:
                    if np.dot(fn[fj], fn[fi]) >= cosc: n += fn[fj]
                l = np.linalg.norm(n); n = n / l if l > 1e-12 else fn[fi]
            else: n = fn[fi]
            corners.append((P[vi], n, (u * tr[0] + to[0], v * tr[1] + to[1])))
        for k in range(1, len(corners) - 1):
            for c in (corners[0], corners[k], corners[k + 1]):
                b['pos'].append(c[0]); b['nrm'].append(c[1]); b['uv'].append(c[2]); b['col'].append(col)

def walk(xml_path, M_parent, sub, depth=0):
    loc = os.path.join(ROOT, xml_path)
    if not os.path.exists(loc): print('missing xml', xml_path); return
    root = ET.parse(loc).getroot()
    hidden = hidden_names(root)
    anims = parse_anims(root, M_parent)
    acp = root.findtext('path')
    if acp:
        ac = repo_path(acp, xml_path)
        acl = os.path.join(ROOT, ac)
        if os.path.exists(acl) and ac.endswith('.ac'):
            mats, objs = parse_ac(acl)
            for o in objs: add_object(o, mats, ac, M_parent, sub, hidden, anims)
        else: print('missing ac', ac)
    for m in root.findall('model'):
        nm = (m.findtext('name') or '?').strip()
        p = m.findtext('path')
        if not p: continue
        if nm in SKIP or posixpath.basename(p.strip()) in SKIP or nm in hidden: continue
        c = m.find('condition')
        if c is not None and not cond(c): continue
        child = repo_path(p, xml_path)
        M = M_parent @ offsets_matrix(m.find('offsets'))
        if child.endswith('.xml'): walk(child, M, nm, depth + 1)
        elif child.endswith('.ac'):
            acl = os.path.join(ROOT, child)
            if os.path.exists(acl):
                mats, objs = parse_ac(acl)
                for o in objs: add_object(o, mats, child, M, nm)

walk(ROOT_XML, np.eye(4), 'cockpit')

# ----------------------------------------------------------------------------- textures
def load_texture(repo_rel):
    if repo_rel in tex_cache: return tex_cache[repo_rel]
    p = os.path.join(ROOT, repo_rel)
    if not os.path.exists(p):
        # FlightGear falls back to .png/.rgb/.dds siblings
        base = os.path.splitext(p)[0]
        for ext in ('.png', '.dds', '.rgb', '.jpg'):
            if os.path.exists(base + ext): p = base + ext; break
    if not os.path.exists(p): tex_cache[repo_rel] = None; return None
    try:
        im = Image.open(p); im.load()
    except Exception as e:
        print('bad texture', repo_rel, e); tex_cache[repo_rel] = None; return None
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    im = im.convert('RGBA' if has_alpha else 'RGB')
    if has_alpha and im.getextrema()[3][0] >= 250: has_alpha = False; im = im.convert('RGB')
    s = min(1.0, MAXTEX / max(im.size))
    if s < 1: im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    buf = io.BytesIO()
    if has_alpha: im.save(buf, 'PNG', optimize=True); mime = 'image/png'
    else: im.save(buf, 'JPEG', quality=88, optimize=True); mime = 'image/jpeg'
    tex_cache[repo_rel] = (buf.getvalue(), mime, has_alpha)
    return tex_cache[repo_rel]

# ----------------------------------------------------------------------------- GLB writer
bin_chunks = []; offset = 0
bufferViews, accessors, meshes, nodes, materials, textures, images, samplers = [], [], [], [], [], [], [], [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
def add_view(data, target=None):
    global offset
    pad = (-len(data)) % 4
    bv = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)}
    if target: bv['target'] = target
    bin_chunks.append(data + b'\0' * pad); offset += len(data) + pad
    bufferViews.append(bv); return len(bufferViews) - 1
def add_accessor(arr, comp, typ, target=None, minmax=False):
    v = add_view(arr.tobytes(), target)
    a = {'bufferView': v, 'componentType': comp, 'count': len(arr), 'type': typ}
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accessors.append(a); return len(accessors) - 1
img_index = {}
def texture_index(repo_rel):
    if repo_rel in img_index: return img_index[repo_rel]
    t = load_texture(repo_rel)
    if not t: img_index[repo_rel] = (None, False); return img_index[repo_rel]
    data, mime, alpha = t
    v = add_view(data)
    images.append({'bufferView': v, 'mimeType': mime, 'name': os.path.basename(repo_rel)})
    textures.append({'source': len(images) - 1, 'sampler': 0})
    img_index[repo_rel] = (len(textures) - 1, alpha)
    return img_index[repo_rel]

prims_total = 0
groups = {}  # dyn key ('' = static) -> [node indices]
for key, b in batches.items():
    if not b['pos']: continue
    pos = np.array(b['pos'], dtype=np.float32); nrm = np.array(b['nrm'], dtype=np.float32); uv = np.array(b['uv'], dtype=np.float32)
    col = np.array(b['col'], dtype=np.uint8)
    uv[:, 1] = 1.0 - uv[:, 1]  # AC3D v up -> glTF v down
    ntri = len(pos) // 3
    # weld identical corners into an indexed mesh
    q = np.c_[np.round(pos / 1e-5), np.round(nrm / 2e-3), np.round(uv / 1e-5), col].astype(np.int64)
    _, first, idx = np.unique(q, axis=0, return_index=True, return_inverse=True)
    pos, nrm, uv, col = pos[first], nrm[first], uv[first], col[first]
    idx = idx.reshape(-1).astype(np.uint16 if len(first) < 65536 else np.uint32)
    m = b['mat']
    emis = b['emis']; trans = b['trans']
    ti, alpha = texture_index(b['tex']) if b['tex'] else (None, False)
    pbr = {'baseColorFactor': [1.0, 1.0, 1.0, 1.0 - trans], 'metallicFactor': 0.0, 'roughnessFactor': b['rough']}
    if ti is not None: pbr['baseColorTexture'] = {'index': ti}
    mat = {'name': os.path.basename(b['tex'] or '') or m['name'], 'pbrMetallicRoughness': pbr, 'doubleSided': bool(b['twosided'])}
    if any(e > 0.01 for e in emis):
        mat['emissiveFactor'] = [min(1, e) for e in emis]
        if ti is not None: mat['emissiveTexture'] = {'index': ti}
    if trans > 0.01 or alpha: mat['alphaMode'] = 'BLEND' if trans > 0.01 else 'MASK'
    if alpha and trans <= 0.01: mat['alphaCutoff'] = 0.4
    materials.append(mat)
    attrs = {'POSITION': add_accessor(pos, 5126, 'VEC3', 34962, True), 'NORMAL': add_accessor(nrm, 5126, 'VEC3', 34962), 'TEXCOORD_0': add_accessor(uv, 5126, 'VEC2', 34962)}
    if (col[:, :3] != 255).any():
        attrs['COLOR_0'] = add_accessor(col, 5121, 'VEC4', 34962)
        accessors[-1]['normalized'] = True
    prim = {'attributes': attrs,
            'indices': add_accessor(idx, 5123 if idx.dtype == np.uint16 else 5125, 'SCALAR', 34963), 'material': len(materials) - 1}
    meshes.append({'name': m['name'], 'primitives': [prim]})
    nodes.append({'name': f"{m['name']}|{os.path.basename(b['tex'] or '')}", 'mesh': len(meshes) - 1})
    groups.setdefault(b['dyn'], []).append(len(nodes) - 1)
    prims_total += ntri
roots = []
for key, kids in sorted(groups.items()):
    nodes.append({'name': 'dyn:' + key if key else 'static', 'children': kids}); roots.append(len(nodes) - 1)
extras = {'dyn': dyn_info, 'anchors': anchors}
gltf = {'asset': {'version': '2.0', 'generator': 'stratos fg-ac2glb', 'copyright': 'FlightGear F-16 cockpit (GPL-2.0-or-later), see CREDITS'},
        'scene': 0, 'scenes': [{'nodes': roots, 'extras': extras}], 'nodes': nodes, 'meshes': meshes, 'materials': materials,
        'accessors': accessors, 'bufferViews': bufferViews, 'buffers': [{'byteLength': offset}]}
if textures: gltf.update({'textures': textures, 'images': images, 'samplers': samplers})
js = json.dumps(gltf, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4)
binb = b''.join(bin_chunks)
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'f16-cockpit.glb'), 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
json.dump(report, open(os.path.join(OUT, 'report.json'), 'w'), indent=0)
json.dump(extras, open(os.path.join(OUT, 'extras.json'), 'w'), indent=1)
print(f'batches {len(meshes)}  dyn groups {len(groups) - 1}  triangles {prims_total}  textures {len(textures)}  glb {os.path.getsize(os.path.join(OUT, "f16-cockpit.glb"))/1048576:.2f} MB')

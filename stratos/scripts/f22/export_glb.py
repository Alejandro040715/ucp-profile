"""
F-22 Raptor (.blend) -> game-ready GLB for STRATOS.

Run with Blender's Python module (pip install bpy):
    python export_glb.py <F22_Raptor_Perfil.blend> <out_dir> [atlas_px]

What it does
- drops cameras, lights, reference empties, the studio floor and the F-22's
  own simplified cockpit interior (the game installs the F-16 cockpit);
- converts curves / text to meshes and applies every modifier;
- cuts the cockpit opening out of the fuselage loft under the canopy
  (plan-view silhouette of the bubble, inset 4 cm);
- rigs the moving parts under named empties whose origin is the pivot
  (stabilators, 2D-nozzle flaps, canopy, gear legs / steering / oleo pistons /
  wheels, gear doors) and adds anchor empties for lights and nozzle exits;
- bakes the procedural livery (normal-weighted dorsal / ventral / side image
  projections + noise camo) to one albedo atlas on a fresh UV layout;
- joins everything static into one mesh and each moving group into one mesh,
  collapses materials to a few roughness / metalness classes, exports GLB.

Blender frame of the source: x aft (nose at -9.45), y right (port = -y), z up,
ground at z = 0. The game maps glTF coordinates to its body frame at load time.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

SRC, OUT = sys.argv[1], sys.argv[2]
ATLAS = int(sys.argv[3]) if len(sys.argv) > 3 else 4096
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=SRC)
scene = bpy.context.scene
view = bpy.context.view_layer

INTERIOR = ('ACES seat', 'Avionics', 'Cockpit •', 'Console', 'Control stick', 'HUD •', 'Instrument', 'MFD', 'Pedal',
            'Seat •', 'Stick •', 'Studio floor')

# ---------------------------------------------------------------- cleanup
for o in list(bpy.data.objects):
    if o.type not in ('MESH', 'CURVE', 'FONT') or o.name.startswith(INTERIOR) or o.hide_render:
        bpy.data.objects.remove(o, do_unlink=True)

def select(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    view.objects.active = active or (objs[0] if objs else None)

objs = [o for o in scene.objects]
select(objs)
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.convert(target='MESH')
for o in list(scene.objects):
    if o.type != 'MESH' or len(o.data.polygons) == 0:
        bpy.data.objects.remove(o, do_unlink=True)
print('meshes after convert', len(scene.objects))

def bbox(o):
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx

def bbox_all(os_):
    bs = [bbox(o) for o in os_]
    return (Vector((min(b[0].x for b in bs), min(b[0].y for b in bs), min(b[0].z for b in bs))),
            Vector((max(b[1].x for b in bs), max(b[1].y for b in bs), max(b[1].z for b in bs))))

def find(prefix):
    return [o for o in scene.objects if o.name.startswith(prefix)]

def one(name):
    return bpy.data.objects[name]

# ---------------------------------------------------------------- cockpit opening
bubble = one('Canopy • low profile reference bubble')
bw = bubble.matrix_world
bverts = [bw @ v.co for v in bubble.data.vertices]
zmin = min(p.z for p in bverts)
sill = [p for p in bverts if p.z < zmin + 0.1]

def half_width(x):
    near = [abs(p.y) for p in sill if abs(p.x - x) < 0.12]
    return max(near) if near else 0.0

fus = one('Fuselage • continuous chine loft')

def hull2d(points):
    """monotone-chain convex hull, counter-clockwise"""
    pts = sorted(set(points))
    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h
    lo, hi = half(pts), half(reversed(pts))
    return lo[:-1] + hi[:-1]

# a prism on the canopy sill outline (inset 4 cm) cuts the opening the F-16
# cockpit tub sits in; the canopy's painted perimeter band hides the edge
# (plan-view silhouette of the whole bubble: its sill rises towards the back)
ring = hull2d([(round(p.x, 3), round(p.y, 3)) for p in bverts])
cx = sum(p[0] for p in ring) / len(ring); cy = sum(p[1] for p in ring) / len(ring)
inset = []
for x, y in ring:
    dx, dy = x - cx, y - cy
    d = math.hypot(dx, dy) or 1
    inset.append((x - dx / d * 0.04, y - dy / d * 0.04))
def inside(x, y):
    """point in the inset sill polygon"""
    c = False
    for i in range(len(inset)):
        x1, y1 = inset[i]; x2, y2 = inset[(i + 1) % len(inset)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c

# the loft is an open surface (no boolean): split its faces along the outline
# with vertical planes, then delete the deck faces inside it
xs = [p[0] for p in inset]; ys = [p[1] for p in inset]
bm = bmesh.new(); bm.from_mesh(fus.data)
bm.transform(fus.matrix_world)
before = len(bm.faces)
for i in range(len(inset)):
    (x1, y1), (x2, y2) = inset[i], inset[(i + 1) % len(inset)]
    if math.hypot(x2 - x1, y2 - y1) < 1e-4: continue
    region = [f for f in bm.faces if min(xs) - 0.4 < f.calc_center_median().x < max(xs) + 0.4 and f.calc_center_median().z > 1.95]
    geom = list({e for f in region for e in f.edges}) + region + list({v for f in region for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((x1, y1, 0)), plane_no=Vector((-(y2 - y1), x2 - x1, 0)).normalized())
cand = [f for f in bm.faces if f.calc_center_median().z > 1.95 and inside(f.calc_center_median().x, f.calc_center_median().y)]
dead = [f for f in cand if abs(f.normal.z) > 0.15]
bmesh.ops.delete(bm, geom=dead, context='FACES')
bm.transform(fus.matrix_world.inverted())
bm.to_mesh(fus.data); bm.free()
print('cockpit opening: fuselage faces', before, '->', len(fus.data.polygons), 'deleted', len(dead))

# ---------------------------------------------------------------- rig
def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    scene.collection.objects.link(e)
    e.location = loc
    if parent:
        e.parent = parent
        e.matrix_parent_inverse = parent.matrix_world.inverted()
    view.update()
    return e

def attach(child, parent):
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw

def group(name, members, pivot, parent=None):
    e = empty(name, pivot, parent)
    for m in members: attach(m, e)
    return e

def root_le(o):
    """root chord (min/max x) of a lifting surface: vertices nearest the fuselage"""
    w = o.matrix_world
    pts = [w @ v.co for v in o.data.vertices]
    ymin = min(abs(p.y) for p in pts)
    root = [p for p in pts if abs(p.y) < ymin + 0.08]
    return min(p.x for p in root), max(p.x for p in root), sum(p.z for p in root) / len(root), ymin

anchors = {}
for side, tag in (('Port', 'L'), ('Starboard', 'R')):
    s = one(f'{side} • Horizontal stabilator')
    le, te, zc, ymin = root_le(s)
    sgn = -1 if tag == 'L' else 1
    group(f'STAB_{tag}', [s], Vector((le + 0.42 * (te - le), sgn * ymin, zc)))
    # 2D nozzle: upper (1) and lower (-1) flap sets hinge at their forward edge
    for flap, nm in (('1', 'UP'), ('-1', 'DN')):
        parts = [one(f'{side} • nozzle {flap} petal {i}') for i in (1, 2, 3)]
        mn, mx = bbox_all(parts)
        group(f'NOZ_{tag}_{nm}', parts, Vector((mn.x, (mn.y + mx.y) / 2, mx.z if nm == 'UP' else mn.z)))
    mn, mx = bbox_all([one(f'{side} • nozzle 1 petal 3'), one(f'{side} • nozzle -1 petal 3')])
    anchors[f'NOZZLE_{tag}'] = Vector((mx.x, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2))
    anchors[f'NOZZLE_{tag}_SIZE'] = Vector((0, mx.y - mn.y, mx.z - mn.z))
    lt = one('Wing • position light' if tag == 'L' else 'Wing • position light.001')
    mn, mx = bbox(lt)
    anchors[f'NAV_{tag}'] = (mn + mx) / 2

# canopy: frameless bubble + glazing seal, hinged at its aft sill
canopy_parts = [bubble] + find('Canopy • glazing seal')
mn, mx = bbox_all(canopy_parts)
bubble.name = 'CANOPY_GLASS'
group('CANOPY', canopy_parts, Vector((mx.x, 0, zmin + 0.04)))
anchors['CANOPY_MIN'] = mn
anchors['CANOPY_MAX'] = mx

# nose gear: leg (hinge at the top of the oleo) > steer > piston > wheel
wheel_n = find('Nose wheel •')
tyre = one('Nose wheel • tyre'); tmn, tmx = bbox(tyre)
axle_n = (tmn + tmx) / 2
up_mn, up_mx = bbox(one('Nose oleo • upper'))
leg_n = group('GEAR_N', [one('Nose gear • drag brace'), one('Nose oleo • upper')] + find('Nose oleo • collar'),
              Vector(((up_mn.x + up_mx.x) / 2, 0, up_mx.z)))
steer_n = group('STEER_N', [], Vector(((up_mn.x + up_mx.x) / 2, 0, axle_n.z)), leg_n)
piston_n = group('PISTON_N', [one('Nose oleo • chrome')] + [o for o in wheel_n if 'fork' in o.name], Vector(((up_mn.x + up_mx.x) / 2, 0, axle_n.z)), steer_n)
group('WHEEL_N', [o for o in wheel_n if 'fork' not in o.name], axle_n, piston_n)
for i, d in enumerate(find('Nose gear • conformal door')):
    dmn, dmx = bbox(d)
    group(f'DOOR_N{i}', [d], Vector(((dmn.x + dmx.x) / 2, (dmn.y + dmx.y) / 2, dmx.z)))
anchors['LANDING'] = Vector((up_mn.x - 0.05, 0, (up_mn.z + up_mx.z) / 2))

# main gear legs
for side, tag in (('Port', 'L'), ('Starboard', 'R')):
    wheel = find(f'{side} main wheel •')
    tmn, tmx = bbox(one(f'{side} main wheel • tyre'))
    axle = (tmn + tmx) / 2
    umn, umx = bbox(one(f'{side} • main oleo upper'))
    leg_parts = [one(f'{side} • main oleo upper'), one(f'{side} • diagonal drag stay'), one(f'{side} • torque link A'),
                 one(f'{side} • faceted main gear door')] + find(f'{side} • oleo collar') + find(f'{side} • hydraulic hose')
    leg = group(f'GEAR_{tag}', leg_parts, Vector(((umn.x + umx.x) / 2, (umn.y + umx.y) / 2, umx.z)))
    cmn, cmx = bbox(one(f'{side} • main oleo chrome'))
    piston = group(f'PISTON_{tag}', [one(f'{side} • main oleo chrome'), one(f'{side} • torque link B')],
                   Vector(((cmn.x + cmx.x) / 2, (cmn.y + cmx.y) / 2, axle.z)), leg)
    group(f'WHEEL_{tag}', wheel, axle, piston)
    anchors[f'AXLE_{tag}'] = axle
anchors['AXLE_N'] = axle_n

tail = one('Aft • central beavertail'); amn, amx = bbox(tail)
anchors['TAIL'] = Vector((amx.x, 0, (amn.z + amx.z) / 2))
fmn, fmx = bbox(fus)
anchors['NOSE_TIP'] = Vector((fmn.x, 0, 0))
anchors['BELLY'] = Vector((1.0, 0, fmn.z))
for k, v in anchors.items():
    empty('ANCHOR_' + k, v)

# ---------------------------------------------------------------- bake the livery
GLASS = {'Canopy • gold coated glass'}
bake_objs = [o for o in scene.objects if o.type == 'MESH' and o.name != 'CANOPY_GLASS' and not o.name.startswith('Wing • position light')]
default = bpy.data.materials.new('F22_default'); default.use_nodes = True
default.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.34, 0.36, 1)
mats = set()
for o in bake_objs:
    if not o.material_slots: o.data.materials.append(default)
    for s in o.material_slots:
        if s.material is None: s.material = default
    # canonical UV layers on every object: R (what unlinked image nodes read),
    # 'Side reference' (read by name in the livery nodes), bake (new layout).
    # Same names in the same order everywhere, so joining for the bake keeps
    # each object's coordinates.
    me = o.data
    n = len(me.loops) * 2
    r_buf, s_buf = [0.0] * n, [0.0] * n
    render = next((l for l in me.uv_layers if l.active_render), None)
    if render: render.data.foreach_get('uv', r_buf)
    if 'Side reference' in me.uv_layers: me.uv_layers['Side reference'].data.foreach_get('uv', s_buf)
    for nm in [l.name for l in me.uv_layers]:
        me.uv_layers.remove(me.uv_layers[nm])
    me.uv_layers.new(name='R').data.foreach_set('uv', r_buf)
    me.uv_layers.new(name='Side reference').data.foreach_set('uv', s_buf)
    uv = me.uv_layers.new(name='bake')
    me.uv_layers['R'].active_render = True
    me.uv_layers.active = uv
    for s in o.material_slots:
        if s.material: mats.add(s.material)
select(bake_objs)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0015, scale_to_bounds=False)
# smart project lays out each object on its own: pack every island together
bpy.ops.uv.select_all(action='SELECT')
bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION', margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')


atlas = bpy.data.images.new('f22_albedo', ATLAS, ATLAS, alpha=False)
props = {}
for m in mats:
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    if bsdf:
        # drop the presentation-only emission mix, keep the surface
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        props[m.name] = (float(bsdf.inputs['Metallic'].default_value), float(bsdf.inputs['Roughness'].default_value))
    node = nt.nodes.new('ShaderNodeTexImage')
    node.image = atlas
    nt.nodes.active = node

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 4
scene.render.bake.margin = 6
# Cycles walks the whole image once per baked object: bake a single joined
# copy (same UVs, same world positions / normals) in one pass instead
select(bake_objs)
bpy.ops.object.duplicate()
copies = list(bpy.context.selected_objects)
for c in copies:
    mw = c.matrix_world.copy()
    c.parent = None
    c.matrix_world = mw
select(copies, copies[0])
bpy.ops.object.join()
baker = view.objects.active
# join resets the active UV layer: bake into the new layout, read through R
baker.data.uv_layers.active = baker.data.uv_layers['bake']
baker.data.uv_layers['R'].active_render = True
select([baker])
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=6, use_clear=True)
bpy.data.objects.remove(baker, do_unlink=True)
atlas.filepath_raw = os.path.join(OUT, 'f22_albedo.png')
atlas.file_format = 'PNG'
atlas.save()
print('baked atlas', ATLAS)

# ---------------------------------------------------------------- materials -> classes
classes = {}
def class_mat(metal, rough):
    key = (round(metal, 1), round(rough, 1))
    if key in classes: return classes[key]
    m = bpy.data.materials.new(f'F22_paint_m{key[0]}_r{key[1]}')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Metallic'].default_value = key[0]
    bsdf.inputs['Roughness'].default_value = key[1]
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = atlas
    uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'bake'
    nt.links.new(uvn.outputs['UV'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    classes[key] = m
    return m

for o in bake_objs:
    for s in o.material_slots:
        if s.material is None: continue
        metal, rough = props.get(s.material.name, (0.0, 0.6))
        s.material = class_mat(metal, rough)
    me = o.data
    for n in [l.name for l in me.uv_layers if l.name != 'bake']:
        me.uv_layers.remove(me.uv_layers[n])

# ---------------------------------------------------------------- join per group
def join(objs, name):
    objs = [o for o in objs if o.type == 'MESH']
    if not objs: return None
    select(objs, objs[0])
    if len(objs) > 1: bpy.ops.object.join()
    o = view.objects.active
    o.name = name
    return o

for e in [o for o in scene.objects if o.type == 'EMPTY' and not o.name.startswith('ANCHOR_')]:
    kids = [c for c in e.children if c.type == 'MESH' and c.name != 'CANOPY_GLASS']
    if kids: join(kids, e.name + '_mesh')
static = [o for o in scene.objects if o.type == 'MESH' and o.parent is None]
join(static, 'STATIC')

tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in scene.objects if o.type == 'MESH')
print('objects', len([o for o in scene.objects if o.type == 'MESH']), 'tris', tris, 'classes', sorted(classes))

bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, 'f22.glb'), export_format='GLB', use_selection=False, export_apply=True,
    export_yup=True, export_image_format='JPEG', export_jpeg_quality=88, export_texcoords=True, export_normals=True,
    export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False, export_animations=False,
)
print('exported', os.path.getsize(os.path.join(OUT, 'f22.glb')) / 1048576, 'MB')

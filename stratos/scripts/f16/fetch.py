# Recursively fetch a FlightGear model XML tree (+ .ac + textures) from the
# NikolaiVChr/f16 GitHub repo via raw.githubusercontent.com.
import os, re, sys, json, urllib.request, posixpath, concurrent.futures as cf
import xml.etree.ElementTree as ET
ROOT = sys.argv[1]
B = 'https://raw.githubusercontent.com/NikolaiVChr/f16/master/'
fetched = {}
def get(path):
    if path in fetched: return fetched[path]
    local = os.path.join(ROOT, path)
    if not os.path.exists(local):
        os.makedirs(os.path.dirname(local), exist_ok=True)
        try:
            with urllib.request.urlopen(B + urllib.request.quote(path), timeout=60) as r: data = r.read()
            open(local, 'wb').write(data)
        except Exception as e:
            fetched[path] = None; return None
    fetched[path] = local
    return local
def repo_path(p, base):
    p = p.strip()
    if p.startswith('Aircraft/f16/'): return p[len('Aircraft/f16/'):]
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), p))
tree = []
def walk_xml(xml_path, depth=0, name='root'):
    loc = get(xml_path)
    if not loc: tree.append((depth, name, xml_path, 'MISSING')); return
    try: root = ET.parse(loc).getroot()
    except Exception as e: tree.append((depth, name, xml_path, 'BADXML')); return
    acp = root.findtext('path')
    ac = repo_path(acp, xml_path) if acp else None
    tree.append((depth, name, xml_path, ac))
    if ac and ac.endswith('.ac'):
        acl = get(ac)
        if acl:
            for t in set(re.findall(r'^texture "([^"]+)"', open(acl, errors='ignore').read(), re.M)):
                get(repo_path(t, ac))
    for m in root.findall('model'):
        p = m.findtext('path')
        if not p: continue
        child = repo_path(p, xml_path)
        nm = m.findtext('name') or '?'
        if child.endswith('.xml'): walk_xml(child, depth + 1, nm)
        else:
            tree.append((depth + 1, nm, child, 'AC-direct'))
            acl = get(child)
            if acl:
                for t in set(re.findall(r'^texture "([^"]+)"', open(acl, errors='ignore').read(), re.M)):
                    get(repo_path(t, child))
walk_xml(sys.argv[2])
for d, n, p, ac in tree: print('  ' * d + f'{n}  [{p}] -> {ac}')
tot = sum(os.path.getsize(v) for v in fetched.values() if v)
print(f'files {sum(1 for v in fetched.values() if v)}  missing {sum(1 for v in fetched.values() if not v)}  {tot/1048576:.1f} MB')
json.dump({k: v for k, v in fetched.items()}, open(os.path.join(ROOT, 'fetched.json'), 'w'), indent=0)

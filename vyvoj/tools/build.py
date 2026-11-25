# Zostaví dist/: index.html s vloženým jadrom a appkou + sw.js, manifest, ikony.
import os, re, shutil, sys, time
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src, dist = os.path.join(root, 'src'), os.path.join(root, 'dist')
os.makedirs(dist, exist_ok=True)
html = open(os.path.join(src, 'index.html'), encoding='utf-8').read()
core = open(os.path.join(src, 'core.js'), encoding='utf-8').read()
app = open(os.path.join(src, 'app.js'), encoding='utf-8').read()
build = time.strftime('%Y%m%d-%H%M')
for name, code in (('core.js', core), ('app.js', app)):
    assert '</script' not in code.lower(), name
html = html.replace('<!--CORE--><script src="core.js"></script>', '<script>\n' + core + '\n</script>')
html = html.replace('<!--APP--><script src="app.js"></script>', '<script>\n' + app + '\n</script>')
html = html.replace('<title>WebTopo</title>', '<title>WebTopo</title>\n<meta name="build" content="' + build + '">')
assert 'src="core.js"' not in html and 'src="app.js"' not in html
open(os.path.join(dist, 'index.html'), 'w', encoding='utf-8').write(html)
sw = open(os.path.join(src, 'sw.js'), encoding='utf-8').read().replace('__BUILD__', build)
open(os.path.join(dist, 'sw.js'), 'w', encoding='utf-8').write(sw)
for f in ('manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'):
    shutil.copy(os.path.join(src, f), os.path.join(dist, f))
print('dist OK, build', build, '-', len(html) // 1024, 'kB index.html')

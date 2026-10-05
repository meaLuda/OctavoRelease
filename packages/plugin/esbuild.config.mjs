import esbuild from 'esbuild'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

const prod = process.argv[2] === 'production'
const outdir = process.env.OCTAVO_OUT ?? 'dist'
const pkg = JSON.parse(await readFile('manifest.json', 'utf8'))
const buildId = `-o${pkg.version.replace(/\./g, '')}${prod ? '' : Date.now().toString(36)}`

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: `${outdir}/main.js`,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'pdfjs-dist'],
  define: { __FOLIATE_SUFFIX__: JSON.stringify(buildId), __OCTAVO_DEV__: String(!prod) },
  sourcemap: prod ? false : 'inline',
  minify: prod,
  banner: { js: '/*! Octavo for Obsidian. Copyright (c) 2026 Munyala Eliud (MEA Tech). Licensed under AGPL-3.0-or-later; source: https://github.com/meaLuda/OctavoRelease. Includes MIT and BSD-3-Clause code: see THIRD-PARTY-NOTICES.md */' },
  legalComments: 'eof', // keep third-party licence notices in the bundle
  logLevel: 'info',
  treeShaking: true,
})

async function copyAssets() {
  await mkdir(outdir, { recursive: true })
  await copyFile('manifest.json', `${outdir}/manifest.json`)
  await copyFile('styles.css', `${outdir}/styles.css`)
}

if (prod) {
  await ctx.rebuild()
  await copyAssets()
  await ctx.dispose()
} else {
  await copyAssets()
  await ctx.watch()
}

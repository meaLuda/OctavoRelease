// Obsidian's community review runs these rules on every release; run `npm run lint` before tagging.
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js'
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js'

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'test/**', '*.config.*'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      // build-time constants injected by esbuild (declared in src/env.d.ts)
      globals: { __OCTAVO_DEV__: 'readonly', __FOLIATE_SUFFIX__: 'readonly' },
    },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', {
        enforceCamelCaseLower: true,
        brands: [...DEFAULT_BRANDS, 'Octavo Cloud', 'Octavo AI', 'Octavo Reader', 'Octavo', 'KOReader', 'Kindle', 'Readest', 'DeepSeek', 'Ollama', 'Kokoro', 'Elton', 'Weave', 'Annotator', 'PDF++', 'Cloud + AI', 'Zotero Integration', 'Obsidian Sync Standard', 'PDFs', 'EPUBs'],
        acronyms: [...DEFAULT_ACRONYMS, 'EPUB', 'OCR', 'GB', 'MB'],
        ignoreWords: ['China'],
        // quoted menu labels / sample output, and lowercase tag lists, keep their own casing
        ignoreRegex: ['“[^”]*”', '^[a-z0-9-]+(, [a-z0-9-]+)+$'],
      }],
    },
  },
])

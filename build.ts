// Nice contortion, bitch.

import { build } from './src'

build({
	basePath: __dirname,
	extends: './tsconfig.json',
	compilerOptions: {
		rootDir: './src',
		outDir: './dist',
		skipLibCheck: true,
	},
	include: ['src/**/*'],
	exclude: ['**/__tests__', '**/*.test.ts', '**/*.spec.ts', '**/__fixtures__'],
	clean: { outDir: true },
	bundleDeclaration: {
		entryPoint: 'index.d.ts',
	},
})

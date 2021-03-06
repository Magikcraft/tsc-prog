import ts from 'typescript'
import { Color } from '../utils/log'
import { mapToSet } from '../utils/manipulation'
import { findFirstChild, getModuleName } from './syntax-retrieval'

/**
 * @internal
 */
export type Reference = {
	// Symbols with multiple declarations can have different references per declaration,
	// so we must keep track of the declaration.
	declarationIndex: number
	ref: ts.Identifier | ts.ImportTypeNode
	subrefs: Reference[]
}

/**
 * @internal
 */
export class SymbolCollector {
	externalStarModuleNames: Set<string>
	exportSymbols: Map<ts.Symbol, [ts.Symbol, Reference[]]>
	exportNames: Set<ts.__String>
	origSymbols: Set<ts.Symbol>
	globalSymbols: ts.Symbol[]
	globalNames: ts.__String[]

	private program: ts.Program
	private checker: ts.TypeChecker
	private entryFile: ts.SourceFile
	private entrySymbol: ts.Symbol

	constructor(entryFile: ts.SourceFile, program: ts.Program) {
		this.program = program
		this.checker = program.getTypeChecker()
		this.entryFile = entryFile
		this.entrySymbol = this.checker.getSymbolAtLocation(this.entryFile)!

		const { externalStarExports, externalStarModuleNames } = this.getExternalStarExports()
		const entryExports = this.getModuleExports(externalStarExports)

		this.externalStarModuleNames = externalStarModuleNames
		this.exportSymbols = this.getExportSymbolsMap(entryExports)
		this.globalSymbols = this.getGlobalSymbols()

		// Build indexes for easier checks.
		this.origSymbols = mapToSet(this.exportSymbols, ([origSymbol]) => origSymbol)
		this.exportNames = mapToSet(
			this.exportSymbols,
			(_, s) => s.escapedName,
			(_, s) => s.escapedName !== ts.InternalSymbolName.Default // Don't index default name.
		)

		this.globalNames = this.globalSymbols.map((s) => s.escapedName)
	}

	/**
	 * Retrieves exported symbols.
	 * @internal
	 */
	private getExportSymbolsMap(moduleExports: ts.Symbol[]) {
		// Map export symbol to its original one (might be the same), both ways, for indexing and easier retrieving.
		const exportSymbols = new Map<ts.Symbol, [ts.Symbol, Reference[]]>()

		for (const exportSymbol of moduleExports) {
			let origSymbol = exportSymbol

			// Retrieve the original/aliased symbol.
			if (exportSymbol.flags & ts.SymbolFlags.Alias) {
				origSymbol = this.checker.getAliasedSymbol(exportSymbol)
			}

			// Ignore symbols without declarations.
			if (!origSymbol.declarations || !origSymbol.declarations.length) {
				console.warn(Color.yellow(`Symbol ${origSymbol.name} does not have any declaration`))
				continue
			}

			const refs = this.getReferences(origSymbol)

			exportSymbols.set(exportSymbol, [origSymbol, refs])
		}

		return exportSymbols
	}

	/**
	 * Retrieves unexported symbols used by exported symbols.
	 * @internal
	 */
	private getReferences(origSymbol: ts.Symbol): Reference[] {
		// We look in the first declaration to retrieve common source file,
		// since merged and overloaded declarations are in the same source file.
		const sourceFile = origSymbol.declarations[0].getSourceFile()

		// Don't search in external symbol declarations.
		if (
			this.program.isSourceFileFromExternalLibrary(sourceFile) ||
			this.program.isSourceFileDefaultLibrary(sourceFile)
		) {
			return []
		}

		const getSubReferences = (identifier: ts.Identifier): Reference[] => {
			let refSymbol = this.checker.getSymbolAtLocation(identifier)

			// Avoid infinite loop.
			if (!refSymbol || refSymbol === origSymbol) return []

			if (refSymbol.flags & ts.SymbolFlags.Alias) {
				refSymbol = this.checker.getAliasedSymbol(refSymbol)
			}

			if (!refSymbol.declarations || !refSymbol.declarations.length) return []

			return this.getReferences(refSymbol)
		}

		const refs: Reference[] = []

		// tslint:disable-next-line: prefer-for-of
		for (let declarationIndex = 0; declarationIndex < origSymbol.declarations.length; declarationIndex++) {
			const declaration = origSymbol.declarations[declarationIndex]

			if (ts.isSourceFile(declaration)) continue

			// Taken from https://github.com/microsoft/rushstack/blob/2cb32ec198/apps/api-extractor/src/analyzer/AstSymbolTable.ts#L298
			declaration.forEachChild(function visit(child) {
				if (
					ts.isTypeReferenceNode(child) ||
					ts.isExpressionWithTypeArguments(child) || // "extends"
					ts.isComputedPropertyName(child) || //  [Prop]:
					ts.isTypeQueryNode(child) // "typeof X"
				) {
					const identifier = findFirstChild<ts.Identifier>(child, ts.SyntaxKind.Identifier)
					if (identifier) {
						refs.push({ ref: identifier, subrefs: getSubReferences(identifier), declarationIndex })
					}
				}

				if (ts.isImportTypeNode(child)) refs.push({ ref: child, subrefs: [], declarationIndex })

				child.forEachChild(visit)
			})
		}

		return refs
	}

	/**
	 * Retrieves exports from file in right order.
	 */
	private getModuleExports(excludes: Set<ts.Symbol> = new Set()): ts.Symbol[] {
		if (this.entrySymbol.escapedName === 'globalThis') {
			return this.checker.getSymbolsInScope(this.entryFile, -1)
		}

		const symbols = this.checker.getExportsOfModule(this.entrySymbol)
		const entryFilePositions = this.getExportsPositions(this.entryFile)

		// console.log(symbols.every((s) => entryFilePositions.has(s)))
		// console.log(Array.from(entryFilePositions).map(([s, n]) => s.name + ':' + n))

		const sorted = symbols
			// Don't collect symbols from star exported external libraries.
			.filter((symbol) => !excludes.has(symbol))
			.sort((symbolA, symbolB) => {
				const posA = entryFilePositions.get(symbolA)
				if (posA == null) {
					console.warn(Color.yellow(`export position not found for ${symbolA.escapedName}`))
					return 0
				}

				const posB = entryFilePositions.get(symbolB)
				if (posB == null) {
					console.warn(Color.yellow(`export position not found for ${symbolA.escapedName}`))
					return 0
				}

				return posA - posB
			})

		return sorted
	}

	/**
	 * Retrieves export position in entry file so we have original order of exports,
	 * because `getExportsOfModule` places star exports last.
	 */
	private getExportsPositions(entryFile: ts.SourceFile): Map<ts.Symbol, number> {
		const entryFilePositions = new Map<ts.Symbol, number>()

		const getAliasedExportsPositions = (moduleSymbol: ts.Symbol) => {
			if (!moduleSymbol.exports) return

			moduleSymbol.exports.forEach((symbol, name) => {
				if (name === ts.InternalSymbolName.ExportStar) return
				const pos = symbol.declarations[0].getStart(entryFile)
				entryFilePositions.set(symbol, pos)
			})
		}

		const getInternalStarExportsPositions = (moduleSymbol: ts.Symbol, entryExportDeclaration?: ts.Declaration) => {
			if (!moduleSymbol.exports) return

			const starExportSymbol = moduleSymbol.exports.get(ts.InternalSymbolName.ExportStar)
			if (!starExportSymbol) return

			for (const exportDeclaration of starExportSymbol.declarations) {
				if (!ts.isExportDeclaration(exportDeclaration)) continue

				const resolved = this.getResolvedModule(exportDeclaration)

				if (resolved.isExternalLibraryImport === true) continue

				for (const symbol of this.checker.getExportsOfModule(resolved.moduleSymbol)) {
					// Keep reference of the entry file declaration for nested star exports.
					if (entryExportDeclaration) {
						const pos = entryExportDeclaration.getStart(entryFile)
						entryFilePositions.set(symbol, pos)
					} else {
						const pos = exportDeclaration.getStart(entryFile)
						entryFilePositions.set(symbol, pos)
					}
				}

				getInternalStarExportsPositions(resolved.moduleSymbol, exportDeclaration)
			}
		}

		getAliasedExportsPositions(this.entrySymbol)
		getInternalStarExportsPositions(this.entrySymbol)

		return entryFilePositions
	}

	/**
	 * Not always reliable, since we also get global symbols from dev packages like jest (`it`).
	 * @see https://github.com/microsoft/rushstack/issues/1316
	 * @see https://github.com/rbuckton/typedoc-plugin-biblio/blob/master/src/plugin.ts
	 */
	private getGlobalSymbols(): ts.Symbol[] {
		const allSourceFiles = this.program.getSourceFiles()
		const globalSourceFile =
			allSourceFiles.find((sf) => sf.hasNoDefaultLib) || allSourceFiles.find((sf) => !ts.isExternalModule(sf))

		return this.checker.getSymbolsInScope(globalSourceFile!, -1)
	}

	/**
	 * Recursively retrieves symbols star exported from external libraries
	 * so we don't manipulate them later and simply expose them as `export * from "lib"`.
	 */
	private getExternalStarExports() {
		const externalStarExports = new Set<ts.Symbol>()
		const externalStarModuleNames = new Set<string>()

		const recurse = (moduleSymbol: ts.Symbol) => {
			if (!moduleSymbol.exports) return

			const starExportSymbol = moduleSymbol.exports.get(ts.InternalSymbolName.ExportStar)
			if (!starExportSymbol) return

			for (const declaration of starExportSymbol.declarations) {
				if (!ts.isExportDeclaration(declaration)) continue

				const resolved = this.getResolvedModule(declaration)

				if (resolved.isExternalLibraryImport === true) {
					for (const symbol of this.checker.getExportsOfModule(resolved.moduleSymbol)) {
						externalStarExports.add(symbol)
						externalStarModuleNames.add(resolved.moduleName)
					}
				} else {
					recurse(resolved.moduleSymbol)
				}
			}
		}

		recurse(this.entrySymbol)

		return { externalStarExports, externalStarModuleNames }
	}

	/**
	 * Resolves modules, made for star exported declarations (all have an module specifier).
	 * `export * from "module"`
	 */
	private getResolvedModule(declaration: ts.ExportDeclaration): ResolvedModule {
		const moduleName = getModuleName(declaration)
		if (!moduleName) throw Error('Could not get module specifier from: ' + declaration.getText())

		const resolvedModule = ts.getResolvedModule(declaration.getSourceFile(), moduleName)

		if (resolvedModule) {
			const sourceFile = this.program.getSourceFile(resolvedModule.resolvedFileName)
			if (!sourceFile) throw Error('Could not locate file: ' + resolvedModule.resolvedFileName)
			const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)!

			return {
				moduleName,
				fileName: resolvedModule.resolvedFileName,
				sourceFile,
				moduleSymbol,
				isExternalLibraryImport: resolvedModule.isExternalLibraryImport || false,
			}
		}

		// The 'module' keyword can be used to declare multiple modules in a library (e.g. with '@types/node'),
		// so we can't resolve them properly with 'ts.getResolvedModule'.
		else {
			// A relative name should have been picked by 'ts.getResolvedModule'.
			if (ts.isExternalModuleNameRelative(moduleName)) {
				throw Error('Could not resolve module: ' + moduleName)
			}

			const moduleSymbol = this.checker.getSymbolAtLocation(declaration.moduleSpecifier! /* checked by getModuleName */)

			if (!moduleSymbol || !(moduleSymbol.flags & ts.SymbolFlags.ValueModule) || !moduleSymbol.declarations) {
				throw Error('Could not resolve symbol of module: ' + moduleName)
			}

			const sourceFile = moduleSymbol.declarations[0].getSourceFile()

			return {
				moduleName,
				fileName: sourceFile.fileName,
				sourceFile,
				moduleSymbol,
				isExternalLibraryImport: this.program.isSourceFileFromExternalLibrary(sourceFile),
			}
		}
	}
}

/**
 * @internal
 */
type ResolvedModule = {
	moduleName: string
	fileName: string
	sourceFile: ts.SourceFile
	moduleSymbol: ts.Symbol
	isExternalLibraryImport: boolean
}

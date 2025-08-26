/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	type DocumentDiagnosticReport
    , SemanticTokensBuilder, SemanticTokens
} from 'vscode-languageserver/node';
import * as fs from 'fs';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false
			}
		}
	};

	// Add semantic tokens capability (full provider)
	// Only expose the token types used by SchemaLang: type, variable, builtin, modifier, gen_modifier, generator, comment, string
	// NOTE: keep the order in sync with server-side tokenTypeToIndex
	const tokenTypes = ['type', 'variable', 'builtin', 'modifier', 'gen_modifier', 'generator', 'comment', 'string'];
	const tokenModifiers: string[] = [];

	(result.capabilities as any).semanticTokensProvider = {
		legend: { tokenTypes, tokenModifiers },
		full: true,
		range: false
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ExampleSettings>>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = (
			(change.settings.languageServerExample || defaultSettings)
		);
	}
	// Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
	// We could optimize things here and re-fetch the setting first can compare it
	// to the existing setting, but this is out of scope for this example.
	connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});


connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document)
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// Simple SchemaLang parser-based diagnostics.
	const text = textDocument.getText();
	const lines = text.split(/\r?\n/);
	const diagnostics: Diagnostic[] = [];
	let problems = 0;

	// Helpers
	function mkDiag(line: number, startChar: number, endChar: number, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
		if (problems >= settings.maxNumberOfProblems) return;
		problems++;
		diagnostics.push({
			severity,
			range: {
				start: { line, character: startChar },
				end: { line, character: endChar }
			},
			message,
			source: 'schemalang'
		});
	}

	// Track block stack for braces
	const stack: { type: 'struct' | 'enum', name: string, line: number }[] = [];

	// Allow optional header modifiers after a ':' so headers like
	//   struct Profile:gens_disabled(MySQL) {
	// are accepted and do not confuse the simple parser.
	const structHeader = /^\s*struct\s+([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*[^\{]+)?\s*\{?/;
	const enumHeader = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*[^\{]+)?\s*\{?/;
	// Capture type (e.g. string, int8, array<Ability>), field name, then modifiers (anything)
	// Modifiers can include parameterized forms like description("text"), reference(Type.member), gens_disabled(MySQL)
	const fieldLine = /^\s*([A-Za-z0-9_<>,]+)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
	const enumItem = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*\d+)?\s*,?\s*(\/\/.*)?$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.match(/^\s*$/)) continue;
		let m;
		if ((m = structHeader.exec(line))) {
			stack.push({ type: 'struct', name: m[1], line: i });
			// if no opening brace on same line, expect one later
			if (!line.includes('{')) {
				// lookahead for next non-empty char
				let found = false;
				for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
					if (lines[j].includes('{')) { found = true; break; }
				}
				if (!found) mkDiag(i, 0, line.length, `Missing '{' after struct ${m[1]}`);
			}
			continue;
		}
		if ((m = enumHeader.exec(line))) {
			stack.push({ type: 'enum', name: m[1], line: i });
			if (!line.includes('{')) {
				let found = false;
				for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
					if (lines[j].includes('{')) { found = true; break; }
				}
				if (!found) mkDiag(i, 0, line.length, `Missing '{' after enum ${m[1]}`);
			}
			continue;
		}
		if (line.includes('}')) {
			if (stack.length === 0) {
				mkDiag(i, line.indexOf('}'), line.indexOf('}') + 1, "Unmatched '}'");
			} else {
				stack.pop();
			}
			continue;
		}
		// inside struct: validate field lines
		if (stack.length > 0 && stack[stack.length - 1].type === 'struct') {
			if (!fieldLine.test(line)) {
				// allow closing brace handled above
				if (!line.trim().startsWith('//')) {
					mkDiag(i, 0, Math.min(80, line.length), `Malformed struct field. Expected 'TYPE: name: modifiers...'`);
				}
			} else {
				// further checks: basic type correctness and common modifier sanity
				const fm = fieldLine.exec(line);
				if (fm) {
					const typePart = fm[1].trim();
					const mods = fm[3].trim();
					// very basic type pattern check: allow names and generics like array<Ability>
					const inner = typePart.replace(/<.*>/, '');
					if (!/^[A-Za-z0-9_]+$/.test(inner)) {
						mkDiag(i, line.indexOf(typePart), line.indexOf(typePart) + typePart.length, `Malformed type '${typePart}'`);
					}
					// check for at least one description(...) modifier as README suggests descriptions are important
					if (!/description\s*\(/.test(mods) && !mods.includes('description:') && !mods.includes('description')) {
						// only warn, not error
						mkDiag(i, Math.max(0, line.indexOf(':')), Math.min(line.length, line.indexOf(':') + 40), `Warning: field missing 'description(...)' modifier` , DiagnosticSeverity.Warning);
					}
				}
			}
			continue;
		}
		// inside enum: validate items
		if (stack.length > 0 && stack[stack.length - 1].type === 'enum') {
			if (!enumItem.test(line) && !line.trim().startsWith('//')) {
				mkDiag(i, 0, Math.min(80, line.length), `Malformed enum item or unexpected line in enum`);
			}
			continue;
		}
		// top-level unknown lines - maybe ok, but warn about lines starting with unexpected tokens
		if (!line.trim().startsWith('//') && !line.trim().startsWith('struct') && !line.trim().startsWith('enum')) {
			// no-op for now
		}
	}

	// leftover unclosed blocks
	for (const b of stack) {
		mkDiag(b.line, 0, 20, `Unclosed ${b.type} '${b.name}' starting here`);
	}

	return diagnostics;
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// Provide SchemaLang-relevant completions
		return [
			{ label: 'struct', kind: CompletionItemKind.Keyword, data: 1 },
			{ label: 'enum', kind: CompletionItemKind.Keyword, data: 2 },
			{ label: 'string', kind: CompletionItemKind.TypeParameter, data: 3 },
			{ label: 'int8', kind: CompletionItemKind.TypeParameter, data: 4 },
			{ label: 'int64', kind: CompletionItemKind.TypeParameter, data: 5 },
			{ label: 'float', kind: CompletionItemKind.TypeParameter, data: 6 },
			{ label: 'bool', kind: CompletionItemKind.TypeParameter, data: 7 },
			{ label: 'array<...>', kind: CompletionItemKind.TypeParameter, data: 8 }
			,
			// common modifiers seen in README and rpg.schema
			{ label: 'required', kind: CompletionItemKind.Keyword, data: 20 },
			{ label: 'optional', kind: CompletionItemKind.Keyword, data: 21 },
			{ label: 'unique', kind: CompletionItemKind.Keyword, data: 22 },
			{ label: 'min_items(', kind: CompletionItemKind.Function, data: 23 },
			{ label: 'max_items(', kind: CompletionItemKind.Function, data: 24 },
			{ label: 'description("', kind: CompletionItemKind.Snippet, data: 25 },
			{ label: 'reference(', kind: CompletionItemKind.Function, data: 26 },
			{ label: 'gens_enabled(', kind: CompletionItemKind.Function, data: 27 },
			{ label: 'gens_disabled(', kind: CompletionItemKind.Function, data: 28 }
			,
			// known generator names (helpful inside gens_enabled/disabled parentheses)
			{ label: 'Cpp', kind: CompletionItemKind.Value, data: 40 },
			{ label: 'Java', kind: CompletionItemKind.Value, data: 41 },
			{ label: 'MySQL', kind: CompletionItemKind.Value, data: 42 },
			{ label: 'SQLite', kind: CompletionItemKind.Value, data: 43 },
			{ label: 'JSON', kind: CompletionItemKind.Value, data: 44 },
			{ label: 'Lua', kind: CompletionItemKind.Value, data: 45 }
			];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// --- Semantic tokens provider (full) --------------------------------------------------------
// Simple semantic tokens implementation: scans lines and emits tokens for
// types, variables, modifiers (including generator modifiers), strings and comments.
const tokenTypeToIndex: { [s: string]: number } = {};
['type', 'variable', 'builtin', 'modifier', 'gen_modifier', 'generator', 'comment', 'string'].forEach((t, i) => tokenTypeToIndex[t] = i);

const rxComment = /\/\/.*|\/\*[\s\S]*?\*\//g;
const rxString = /"(?:\\.|[^"\\])*"/g;
const rxStructEnum = /^\s*(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;
// field: type: name: ...  -- tighten to require type start with letter/underscore
const rxField = /^\s*([A-Za-z_][A-Za-z0-9_<>,\s]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/;
// generic array matcher, allow optional spaces inside angle brackets
const rxTypeGeneric = /\barray\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/gi;
// modifiers and parameterized modifiers (exclude 'reference' and gens_ handled by dedicated regexes)
// make modifier matching case-insensitive to be more robust
const rxModifier = /\b(required|optional|unique|auto_increment|primary_key|min_items|max_items|min|max|description)\b/gi;
const rxReference = /reference\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
// gens_ may contain generator names with letters, numbers, and underscores; case-insensitive
const rxGens = /gens_(enabled|disabled)\s*\(\s*([A-Za-z0-9_\-,\s]+)\s*\)/gi;
// simple gens_ token (no parentheses) e.g. a standalone 'gens_disabled'
const rxGensSimple = /\bgens_(enabled|disabled)\b/gi;
// known generators to highlight specially when appearing as arguments inside gens_enabled/disabled
const knownGenerators = ['Cpp','Java','MySQL','SQLite','JSON','Lua'];

// builtin/primitive types to highlight as 'type'
const builtinTypes = ['bool','string','int8','int16','int32','int64','uint8','uint16','uint32','uint64','float','double','array','void','pointer'];
// match builtin type names as whole words (case-insensitive)
const rxBuiltin = new RegExp('\\b(' + builtinTypes.join('|') + ')\\b','gi');

function provideSemanticTokensFull(textDocument: TextDocument): SemanticTokens {
	const text = textDocument.getText();
	const lines = text.split(/\r?\n/);
	const builder = new SemanticTokensBuilder();
	const collected: { line: number; start: number; len: number; t: number; mod: number }[] = [];

	// Track occupied columns per line to avoid overlapping tokens. This helps themes apply
	// a single style per source span and avoids 'overlapping semantic tokens' warnings.
	const occupied: (number[] | undefined)[] = new Array(lines.length);

	function markOccupied(lineIndex: number, startCol: number, len: number) {
		if (!occupied[lineIndex]) occupied[lineIndex] = [];
		occupied[lineIndex]!.push(startCol, startCol + len);
	}

	function isOverlapping(lineIndex: number, startCol: number, len: number) {
		const arr = occupied[lineIndex];
		if (!arr) return false;
		const endCol = startCol + len;
		for (let i = 0; i < arr.length; i += 2) {
			const s = arr[i];
			const e = arr[i + 1];
			if (!(endCol <= s || startCol >= e)) return true;
		}
		return false;
	}

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		// comments: reserve token ranges first so other tokens won't overlap
		let m: RegExpExecArray | null;
		rxComment.lastIndex = 0;
		while ((m = rxComment.exec(line)) !== null) {
			const s = m.index;
			const l = m[0].length;
			if (!isOverlapping(lineIndex, s, l)) {
				collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['comment'], mod: 0 });
				markOccupied(lineIndex, s, l);
			}
		}

		// strings: reserve ranges so types/modifiers inside strings aren't colored
		rxString.lastIndex = 0;
		while ((m = rxString.exec(line)) !== null) {
			const s = m.index;
			const l = m[0].length;
			if (!isOverlapping(lineIndex, s, l)) {
				collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['string'], mod: 0 });
				markOccupied(lineIndex, s, l);
			}
		}

		// early scan for gens_* tokens (parenthesized or standalone) so they get keyword-like styling
		// parenthesized form (gens_enabled(...)) - we'll at least mark the gens_ word and inner args early
		rxGens.lastIndex = 0;
		let ggEarly: RegExpExecArray | null;
		while ((ggEarly = rxGens.exec(line)) !== null) {
			const gensWord = 'gens_' + ggEarly[1];
			const gensPos = line.toLowerCase().indexOf(gensWord.toLowerCase(), ggEarly.index);
			if (gensPos >= 0 && !isOverlapping(lineIndex, gensPos, gensWord.length)) {
				collected.push({ line: lineIndex, start: gensPos, len: gensWord.length, t: tokenTypeToIndex['gen_modifier'], mod: 0 });
				markOccupied(lineIndex, gensPos, gensWord.length);
			}
			// mark generator name args inside parentheses as gen_modifier as well
			const args = ggEarly[2] || '';
			const argsStart = line.indexOf('(', ggEarly.index) + 1;
			if (argsStart > 0) {
				const parts = args.split(',').map(p => p.trim()).filter(Boolean);
				let offset = argsStart;
				for (const p of parts) {
					const pPos = line.indexOf(p, offset);
					if (pPos >= 0 && !isOverlapping(lineIndex, pPos, p.length)) {
						const isKnown = knownGenerators.some(k => k.toLowerCase() === p.toLowerCase());
						collected.push({ line: lineIndex, start: pPos, len: p.length, t: tokenTypeToIndex[isKnown ? 'generator' : 'gen_modifier'], mod: 0 });
						markOccupied(lineIndex, pPos, p.length);
					}
					offset = (pPos >= 0) ? (pPos + p.length) : offset + p.length;
				}
			}
		}

		// standalone gens_enabled / gens_disabled (no parentheses)
		rxGensSimple.lastIndex = 0;
		let gsEarly: RegExpExecArray | null;
		while ((gsEarly = rxGensSimple.exec(line)) !== null) {
			const s = gsEarly.index;
			const l = gsEarly[0].length;
			if (!isOverlapping(lineIndex, s, l)) {
				collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['gen_modifier'], mod: 0 });
				markOccupied(lineIndex, s, l);
			}
		}

		// struct / enum headers
		const se = rxStructEnum.exec(line);
		if (se) {
		    const kw = se[1];
		    const name = se[2];
		    const kwIndex = line.indexOf(kw);
		    // map language keywords (struct/enum) to the 'modifier' token in our limited legend
			if (kwIndex >= 0 && !isOverlapping(lineIndex, kwIndex, kw.length)) {
				collected.push({ line: lineIndex, start: kwIndex, len: kw.length, t: tokenTypeToIndex['modifier'], mod: 0 });
				markOccupied(lineIndex, kwIndex, kw.length);
			}
			const nameIndex = line.indexOf(name, kwIndex + kw.length);
			// struct/enum name is a type
			if (nameIndex >= 0 && !isOverlapping(lineIndex, nameIndex, name.length)) {
				collected.push({ line: lineIndex, start: nameIndex, len: name.length, t: tokenTypeToIndex['type'], mod: 0 });
				markOccupied(lineIndex, nameIndex, name.length);
			}
			continue;
		}

	// field lines: type: name: ...
		const f = rxField.exec(line);
		if (f) {
			const typeText = f[1];
			const nameText = f[2];

			const typePos = line.indexOf(typeText);
			if (typePos >= 0) {
				// If this is a generic type like array<Inner>, emit the keyword and inner type separately
				rxTypeGeneric.lastIndex = 0;
				let gm: RegExpExecArray | null;
				let emittedAnyGeneric = false;
				let emittedBuiltin = false;
				while ((gm = rxTypeGeneric.exec(typeText)) !== null) {
					emittedAnyGeneric = true;
					const inner = gm[1];
					// compute exact inner position relative to the whole line
					const innerOffsetInType = gm[0].indexOf(inner);
					const innerPos = typePos + gm.index + innerOffsetInType;
					if (innerPos >= 0 && !isOverlapping(lineIndex, innerPos, inner.length)) {
						collected.push({ line: lineIndex, start: innerPos, len: inner.length, t: tokenTypeToIndex['builtin'], mod: 0 });
						markOccupied(lineIndex, innerPos, inner.length);
					}
					// emit the generic keyword (e.g., 'array') as a type token as well
					const keyword = 'array';
					const kwOffsetInMatch = gm[0].toLowerCase().indexOf(keyword);
					const kwPos = typePos + gm.index + (kwOffsetInMatch >= 0 ? kwOffsetInMatch : 0);
					if (kwPos >= 0 && !isOverlapping(lineIndex, kwPos, keyword.length)) {
						collected.push({ line: lineIndex, start: kwPos, len: keyword.length, t: tokenTypeToIndex['builtin'], mod: 0 });
						markOccupied(lineIndex, kwPos, keyword.length);
					}
				}
				// Also scan the type text for builtin primitive names (int8, bool, string, etc.) and emit them
				rxBuiltin.lastIndex = 0;
				let bm: RegExpExecArray | null;
				while ((bm = rxBuiltin.exec(typeText)) !== null) {
					const innerName = bm[1];
					const innerPos = typePos + bm.index;
					if (innerPos >= 0 && !isOverlapping(lineIndex, innerPos, innerName.length)) {
						collected.push({ line: lineIndex, start: innerPos, len: innerName.length, t: tokenTypeToIndex['builtin'], mod: 0 });
						markOccupied(lineIndex, innerPos, innerName.length);
						emittedBuiltin = true;
					}
				}

				// If no generic or builtin pattern matched, emit the whole type
				if (!emittedAnyGeneric && !emittedBuiltin) {
					if (!isOverlapping(lineIndex, typePos, typeText.length)) {
						collected.push({ line: lineIndex, start: typePos, len: typeText.length, t: tokenTypeToIndex['type'], mod: 0 });
						markOccupied(lineIndex, typePos, typeText.length);
					}
				}
			}

			const namePos = line.indexOf(nameText, (typePos >= 0 ? typePos + typeText.length : 0));
			if (namePos >= 0 && !isOverlapping(lineIndex, namePos, nameText.length)) {
				collected.push({ line: lineIndex, start: namePos, len: nameText.length, t: tokenTypeToIndex['variable'], mod: 0 });
				markOccupied(lineIndex, namePos, nameText.length);
			}

			const lower = line.toLowerCase();
			// modifiers as dedicated token (case-insensitive)
			rxModifier.lastIndex = 0;
			let mm: RegExpExecArray | null;
			while ((mm = rxModifier.exec(lower)) !== null) {
				const s = mm.index;
				const l = mm[0].length;
				if (!isOverlapping(lineIndex, s, l)) {
					collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['modifier'], mod: 0 });
					markOccupied(lineIndex, s, l);
				}
			}

			// reference(Type.member) - color Type as namespace/type and member as property
			rxReference.lastIndex = 0;
			let rm: RegExpExecArray | null;
			while ((rm = rxReference.exec(line)) !== null) {
				const typeName = rm[1];
				const memberName = rm[2];
				const base = rm.index;
				const typePos = line.indexOf(typeName, base);
				// color referenced type as 'type'
				if (typePos >= 0 && !isOverlapping(lineIndex, typePos, typeName.length)) {
					collected.push({ line: lineIndex, start: typePos, len: typeName.length, t: tokenTypeToIndex['type'], mod: 0 });
					markOccupied(lineIndex, typePos, typeName.length);
				}
				const memPos = line.indexOf(memberName, base + rm[0].indexOf(memberName));
				// referenced member is a variable/property
				if (memPos >= 0 && !isOverlapping(lineIndex, memPos, memberName.length)) {
					collected.push({ line: lineIndex, start: memPos, len: memberName.length, t: tokenTypeToIndex['variable'], mod: 0 });
					markOccupied(lineIndex, memPos, memberName.length);
				}
				// also mark the whole 'reference' modifier if present
				const refPos = line.indexOf('reference', base);
				if (refPos >= 0 && !isOverlapping(lineIndex, refPos, 'reference'.length)) {
					collected.push({ line: lineIndex, start: refPos, len: 'reference'.length, t: tokenTypeToIndex['modifier'], mod: 0 });
					markOccupied(lineIndex, refPos, 'reference'.length);
				}
			}
		}

		// Note: we avoid a broad scan for known type names here because it can
		// produce duplicate tokens (and overlapping ranges) when types are
		// already emitted via field/header parsing. Field-level parsing above
		// already emits the important type tokens.
		// gens_enabled/disabled arguments (generator names) e.g. gens_enabled(Cpp,Java)
		rxGens.lastIndex = 0;
		let gg: RegExpExecArray | null;
		while ((gg = rxGens.exec(line)) !== null) {
			const args = gg[2] || '';
			const base = gg.index;
			const argsStart = line.indexOf('(', base) + 1;
			if (argsStart > 0) {
				const parts = args.split(',').map(p => p.trim()).filter(Boolean);
				let offset = argsStart;
						for (const p of parts) {
							const pPos = line.indexOf(p, offset);
							if (pPos >= 0 && !isOverlapping(lineIndex, pPos, p.length)) {
								const isKnown = knownGenerators.some(k => k.toLowerCase() === p.toLowerCase());
								collected.push({ line: lineIndex, start: pPos, len: p.length, t: tokenTypeToIndex[isKnown ? 'generator' : 'gen_modifier'], mod: 0 });
								markOccupied(lineIndex, pPos, p.length);
							}
							offset = (pPos >= 0) ? (pPos + p.length) : offset + p.length;
						}
			}
			// mark the gens_ word as gen_modifier
			const gensWord = 'gens_' + gg[1];
			const gensPos = line.toLowerCase().indexOf(gensWord.toLowerCase(), gg.index);
			if (gensPos >= 0 && !isOverlapping(lineIndex, gensPos, gensWord.length)) {
				collected.push({ line: lineIndex, start: gensPos, len: gensWord.length, t: tokenTypeToIndex['gen_modifier'], mod: 0 });
				markOccupied(lineIndex, gensPos, gensWord.length);
			}
		}

		// builtin primitive types (bool, int8, string, array, etc.)
		rxBuiltin.lastIndex = 0;
		let bm: RegExpExecArray | null;
		while ((bm = rxBuiltin.exec(line)) !== null) {
			const s = bm.index;
			const l = bm[0].length;
			if (!isOverlapping(lineIndex, s, l)) {
				collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['builtin'], mod: 0 });
				markOccupied(lineIndex, s, l);
			}
		}

		// standalone gens_enabled / gens_disabled (without parens) should be highlighted
		rxGensSimple.lastIndex = 0;
		let gs: RegExpExecArray | null;
		while ((gs = rxGensSimple.exec(line)) !== null) {
			const s = gs.index;
			const l = gs[0].length;
			if (!isOverlapping(lineIndex, s, l)) {
				collected.push({ line: lineIndex, start: s, len: l, t: tokenTypeToIndex['gen_modifier'], mod: 0 });
				markOccupied(lineIndex, s, l);
			}
		}
	}

	// enum items: detect simple enum item lines and color their identifiers as 'variable'
	// Only emit if the item is inside an enum block by scanning backwards for an unclosed enum header.
	function isInsideEnum(lineIdx: number) {
		let depth = 0;
		for (let j = lineIdx - 1; j >= 0; j--) {
			const ln = lines[j];
			if (ln.includes('}')) {
				depth++;
				continue;
			}
			if (ln.includes('{')) {
				if (depth === 0) {
					// check if this is an enum header line
					if (rxStructEnum.test(ln)) {
						const se = rxStructEnum.exec(ln);
						if (se && se[1] && se[1].toLowerCase() === 'enum') return true;
					}
					return false;
				}
				depth--;
			}
		}
		return false;
	}

	// Try to find enum item lines and add tokens for their identifier
	const enumItemRx = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*\d+)?\s*,?\s*(\/\/.*)?$/;
	for (let li = 0; li < lines.length; li++) {
		const l = lines[li];
		if (!l || l.trim().length === 0) continue;
		// skip lines that look like field lines (contain a colon)
		if (l.indexOf(':') >= 0) continue;
		const em = enumItemRx.exec(l);
		if (em && isInsideEnum(li)) {
			const name = em[1];
			const namePos = l.indexOf(name);
			if (namePos >= 0 && !isOverlapping(li, namePos, name.length)) {
				collected.push({ line: li, start: namePos, len: name.length, t: tokenTypeToIndex['variable'], mod: 0 });
				markOccupied(li, namePos, name.length);
			}
		}
	}

	// Emit collected tokens into the builder in stable order.
	collected.sort((a, b) => a.line - b.line || a.start - b.start);
	for (const c of collected) {
		// builder.push(line, char, length, tokenType, tokenModifiers)
		builder.push(c.line, c.start, c.len, c.t, c.mod);
	}

	return builder.build();
}

connection.languages.semanticTokens.on(async (params) => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return { data: [] } as SemanticTokens;
	const tokens = provideSemanticTokensFull(doc);
	// Debug: if this is the large rpg.schema, emit the raw token data to the server console
	try {
		if (params.textDocument.uri.endsWith('rpg.schema') || params.textDocument.uri.endsWith('schema_for_tests.schema')) {
			const out = JSON.stringify((tokens as any).data);
			// append to a workspace temp file
			try { fs.appendFileSync('/run/media/trevor/1TB/lsp-schema-lang/.semantic_tokens_debug.jsonl', out + '\n'); } catch (e) { /* ignore */ }
		}
	} catch (e) {
		// ignore
	}
	return tokens;
});

// Listen on the connection
connection.listen();

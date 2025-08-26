/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import * as assert from 'assert';
import { getDocUri, activate } from './helper';

suite('Schema completion', () => {
	// Use a dedicated test fixture which contains gens_disabled( in a comment
	const docUri = getDocUri('schema_for_tests.schema');

	test('Suggest generator names inside gens_disabled(', async () => {
		await activate(docUri);
		// Find a position near a gens_disabled occurrence or add one temporarily
		const doc = await vscode.workspace.openTextDocument(docUri);
		const text = doc.getText();
		// Find first gens_disabled occurrence or fallback to start
		let index = text.indexOf('gens_disabled');
		let pos = new vscode.Position(0, 0);
		if (index >= 0) {
			const before = text.slice(0, index + 'gens_disabled('.length);
			const line = before.split(/\r?\n/).length - 1;
			const char = before.split(/\r?\n/).pop()!.length;
			pos = new vscode.Position(line, char);
		}

		const actualCompletionList = (await vscode.commands.executeCommand(
			'vscode.executeCompletionItemProvider',
			docUri,
			pos
		)) as vscode.CompletionList;

		// We expect known generator names among completions
		const labels = actualCompletionList.items.map(i => (typeof i.label === 'string' ? i.label : (i.label as any).label));
		const expected = ['Cpp', 'Java', 'MySQL', 'SQLite', 'JSON', 'Lua'];
		expected.forEach(e => assert.ok(labels.includes(e), `Expected completion '${e}' not found`));
	});
});

async function testCompletion(
	docUri: vscode.Uri,
	position: vscode.Position,
	expectedCompletionList: vscode.CompletionList
) {
	await activate(docUri);

	// Executing the command `vscode.executeCompletionItemProvider` to simulate triggering completion
	const actualCompletionList = (await vscode.commands.executeCommand(
		'vscode.executeCompletionItemProvider',
		docUri,
		position
	)) as vscode.CompletionList;

	assert.ok(actualCompletionList.items.length >= 2);
	expectedCompletionList.items.forEach((expectedItem, i) => {
		const actualItem = actualCompletionList.items[i];
		assert.equal(actualItem.label, expectedItem.label);
		assert.equal(actualItem.kind, expectedItem.kind);
	});
}

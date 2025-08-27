import * as vscode from 'vscode';
import * as assert from 'assert';
import { getDocUri, activate } from './helper';

suite('Themes.schema diagnostics', () => {
	const docUri = getDocUri('../../schemas/Themes.schema');

	test('Themes.schema should not have Error diagnostics', async () => {
		await activate(docUri);
		const actualDiagnostics = vscode.languages.getDiagnostics(docUri);
		const errors = actualDiagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
		if (errors.length > 0) {
			console.log('Diagnostics for Themes.schema:');
			errors.forEach(d => console.log(`${d.range.start.line}:${d.range.start.character} - ${d.message}`));
		}
		assert.equal(errors.length, 0, `Found Error diagnostics: ${errors.map(e => e.message).join('; ')}`);
	});
});

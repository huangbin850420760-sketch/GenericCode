import * as vscode from 'vscode';
import { InlineEditSession } from './inlineEditSession';

/**
 * CodeLens provider that surfaces Accept / Reject / Regenerate directly
 * above the active inline-edit hunk.  Only emits lenses for the exact
 * document that owns the current session — everywhere else it returns
 * an empty array so other providers' lenses aren't crowded out.
 *
 * The provider re-fires `onDidChangeCodeLenses` on any session lifecycle
 * transition so lenses appear / disappear immediately.
 */
export class InlineEditLensProvider implements vscode.CodeLensProvider {
	private readonly _onChange = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this._onChange.event;

	/**
	 * Call this whenever the session starts, streams, ends, or toggles
	 * streaming → idle.  Cheap: just fires the event.
	 */
	public refresh(): void {
		this._onChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const s = InlineEditSession.current;
		if (!s) { return []; }
		if (document.uri.toString() !== s.documentUri.toString()) { return []; }
		// Anchor lenses on the FIRST line of the original block — that's
		// always above the proposed block, so accept/reject affordances
		// are visually attached to the hunk.
		const anchor = new vscode.Range(
			s.originalRange.start,
			s.originalRange.start,
		);
		return [
			new vscode.CodeLens(anchor, {
				title: '$(check) Accept (⏎)',
				command: 'genericAgent.inlineEdit.accept',
			}),
			new vscode.CodeLens(anchor, {
				title: '$(close) Reject (⎋)',
				command: 'genericAgent.inlineEdit.reject',
			}),
			new vscode.CodeLens(anchor, {
				title: '$(refresh) Regenerate',
				command: 'genericAgent.inlineEdit.regenerate',
			}),
		];
	}

	dispose(): void {
		this._onChange.dispose();
	}
}

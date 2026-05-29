import * as vscode from 'vscode';
import { Store } from './store';
import { SerializedRange } from './types';

/**
 * Manages editor decorations so annotated ranges are visible inline.
 *
 * Two visual styles:
 *   Purple — annotation referenced by at least one flow step
 *   Blue   — loose note (not in any flow)
 */

export class DecorationManager {
  /** Purple — annotation is part of a flow */
  private annotationType: vscode.TextEditorDecorationType;
  /** Blue — loose note, not assigned to any flow */
  private noteType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: Store) {
    this.annotationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(168, 85, 247, 0.12)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(168, 85, 247, 0.4)',
      overviewRulerColor: 'rgba(168, 85, 247, 0.4)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: false,
    });

    this.noteType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(59, 130, 246, 0.10)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(59, 130, 246, 0.4)',
      overviewRulerColor: 'rgba(59, 130, 246, 0.4)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: false,
    });

    // Re-decorate on editor switch or store change
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(() => this.refresh()),
      store.onDidChange(() => this.refresh())
    );
  }

  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) { return; }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const annotations = this.store.getAllAnnotations();

    // Compute which annotation IDs are referenced by flows
    const referencedIds = new Set<string>();
    for (const flow of this.store.getAllFlows()) {
      for (const step of flow.steps) {
        referencedIds.add(step.annotationId);
      }
    }

    const annotationDecorations: vscode.DecorationOptions[] = [];
    const noteDecorations: vscode.DecorationOptions[] = [];

    for (const ann of Object.values(annotations)) {
      if (ann.filePath !== relativePath) { continue; }

      const range = this.toRange(ann.range);
      const validRange = editor.document.validateRange(range);

      const hoverMessage = new vscode.MarkdownString();
      const label = referencedIds.has(ann.id) ? '**Carabiner** _(annotation)_' : '**Carabiner** _(note)_';
      hoverMessage.appendMarkdown(`${label}\n\n`);
      hoverMessage.appendMarkdown(ann.comment);

      const opts: vscode.DecorationOptions = { range: validRange, hoverMessage };

      if (referencedIds.has(ann.id)) {
        annotationDecorations.push(opts);
      } else {
        noteDecorations.push(opts);
      }
    }

    editor.setDecorations(this.annotationType, annotationDecorations);
    editor.setDecorations(this.noteType, noteDecorations);
  }

  private toRange(r: SerializedRange): vscode.Range {
    return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
  }

  dispose(): void {
    this.annotationType.dispose();
    this.noteType.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

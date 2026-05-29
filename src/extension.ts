import * as vscode from 'vscode';
import * as path from 'path';
import { Store } from './store';
import { DecorationManager } from './decorations';
import { FlowTreeProvider, StepItem, LooseAnnotationItem, ProjectItem } from './treeView';
import { Exporter } from './exporter';
import { Annotation, SerializedRange } from './types';

/** Set by getMultilineInput; invoked by the static carabiner.confirmAnnotation command. */
let pendingConfirm: (() => void) | undefined;

/**
 * Extension entry point.
 *
 * Architecture:
 *   Store         — data persistence (.carabiner/data.json)
 *   DecorationMgr — editor highlights & hover tooltips
 *   FlowTreeProv  — sidebar tree view
 *   Exporter      — markdown generation
 *
 * All commands go through the Store; the Store fires onChange;
 * decorations and tree view react automatically.
 */

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    // Extension needs a workspace to anchor annotations
    return;
  }

  // ── Core services ──────────────────────────────────────────

  const store = new Store(workspaceRoot);
  await store.load();

  const decorations = new DecorationManager(store);
  const treeProvider = new FlowTreeProvider(store);
  const exporter = new Exporter(store, workspaceRoot);

  const treeView = vscode.window.createTreeView('carabinerFlows', {
    treeDataProvider: treeProvider,
  });

  // Initial decoration pass
  decorations.refresh();

  // ── Commands ───────────────────────────────────────────────
  // Collapse All
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.collapseAll', () => {
      vscode.commands.executeCommand('workbench.actions.treeView.carabinerFlows.collapseAll');
    })
  );

  // Confirm annotation (used by status bar button and Ctrl+Enter keybinding)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.confirmAnnotation', () => {
      pendingConfirm?.();
    })
  );
  // Add Note (loose annotation from editor selection)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.addNote', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('Select code to add a note.');
        return;
      }

      const snippet = {
        code: editor.document.getText(selection),
        lang: editor.document.languageId,
      };

      const comment = await getMultilineInput(
        'Note — what do you observe here?',
        '',
        snippet
      );
      if (!comment) { return; }

      const range: SerializedRange = {
        startLine: selection.start.line,
        startChar: selection.start.character,
        endLine: selection.end.line,
        endChar: selection.end.character,
      };

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

      const projectId = await pickProject(store);
      await store.addAnnotation(relativePath, range, comment, projectId ?? undefined);
      vscode.window.showInformationMessage(`Note added at ${relativePath}:${selection.start.line + 1}`);
    })
  );

  // Remove Annotation
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.removeAnnotation', async (item?: LooseAnnotationItem) => {
      // When invoked from the tree context menu the item is passed directly
      if (item instanceof LooseAnnotationItem) {
        await store.removeAnnotation(item.annotation.id);
        vscode.window.showInformationMessage('Note removed.');
        return;
      }

      // Fallback: command palette — show a picker
      const annotations = Object.values(store.getAllAnnotations());
      if (annotations.length === 0) {
        vscode.window.showInformationMessage('No notes to remove.');
        return;
      }
      const items = annotations.map((a) => ({
        label: `${a.filePath}:${a.range.startLine + 1}`,
        description: a.comment.slice(0, 80),
        id: a.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select note to remove',
      });
      if (picked) {
        await store.removeAnnotation(picked.id);
        vscode.window.showInformationMessage('Note removed.');
      }
    })
  );

  // Create Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.createFlow', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Flow name',
        placeHolder: 'e.g. Auth bypass via IDOR, PR #1234 data race',
      });
      if (!name) { return; }

      const flow = await store.createFlow(name);

      // Optionally assign to a project
      const projectId = await pickProject(store);
      if (projectId) {
        await store.setFlowProject(flow.id, projectId);
      }

      // Optionally add a high-level description
      const desc = await vscode.window.showInputBox({
        prompt: 'Optional description (shown at top of export)',
        placeHolder: 'e.g. Unsanitised user input reaches SQL query in 3 hops',
      });
      if (desc) {
        await store.setFlowDescription(flow.id, desc);
      }

      vscode.window.showInformationMessage(`Flow "${name}" created.`);
    })
  );

  // Create Project
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.createProject', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Project name',
        placeHolder: 'e.g. CVE-2024-1234, PR #42, OSWE Lab 3',
      });
      if (!name) { return; }
      await store.createProject(name);
      vscode.window.showInformationMessage(`Project "${name}" created.`);
    })
  );

  // Rename Project
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.renameProject', async (item?: ProjectItem) => {
      const project = item?.project ?? await pickProjectFull(store);
      if (!project) { return; }
      const name = await vscode.window.showInputBox({
        prompt: 'New project name',
        value: project.name,
      });
      if (name) { await store.renameProject(project.id, name); }
    })
  );

  // Delete Project
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.deleteProject', async (item?: ProjectItem) => {
      const project = item?.project ?? await pickProjectFull(store);
      if (!project) { return; }
      const confirm = await vscode.window.showWarningMessage(
        `Delete project "${project.name}"? Flows and notes will become unassigned.`,
        { modal: true },
        'Delete'
      );
      if (confirm === 'Delete') { await store.deleteProject(project.id); }
    })
  );

  // Move Flow to Project
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.moveFlowToProject', async (item?: any) => {
      const flowId = item?.flow?.id || await pickFlow(store, 'Select flow to move');
      if (!flowId) { return; }
      const projectId = await pickProject(store, true);
      await store.setFlowProject(flowId, projectId || undefined);
    })
  );

  // Move Note to Project
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.moveNoteToProject', async (item?: LooseAnnotationItem) => {
      if (!(item instanceof LooseAnnotationItem)) { return; }
      const projectId = await pickProject(store, true);
      await store.setAnnotationProject(item.annotation.id, projectId || undefined);
    })
  );

  // Delete Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.deleteFlow', async (item?: any) => {
      const flowId = item?.flow?.id || await pickFlow(store, 'Select flow to delete');
      if (!flowId) { return; }
      const flow = store.getFlow(flowId);
      const confirm = await vscode.window.showWarningMessage(
        `Delete flow "${flow?.name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm === 'Delete') {
        await store.deleteFlow(flowId);
      }
    })
  );

  // Rename Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.renameFlow', async (item?: any) => {
      const flowId = item?.flow?.id || await pickFlow(store, 'Select flow to rename');
      if (!flowId) { return; }
      const flow = store.getFlow(flowId);
      const name = await vscode.window.showInputBox({
        prompt: 'New name',
        value: flow?.name,
      });
      if (name) {
        await store.renameFlow(flowId, name);
      }
    })
  );

  // Set Flow Description
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.setFlowDescription', async (item?: any) => {
      const flowId = item?.flow?.id || await pickFlow(store, 'Select flow');
      if (!flowId) { return; }
      const flow = store.getFlow(flowId);
      const desc = await vscode.window.showInputBox({
        prompt: 'Flow description',
        value: flow?.description ?? '',
      });
      if (desc !== undefined) {
        await store.setFlowDescription(flowId, desc);
      }
    })
  );

  // Add to Flow (from editor selection — creates annotation + adds to chosen flow in one step)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.addToFlow', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('Select code first.');
        return;
      }

      const flowId = await pickFlow(store, 'Add to which flow?');
      if (!flowId) { return; }

      const snippet = {
        code: editor.document.getText(selection),
        lang: editor.document.languageId,
      };

      const comment = await getMultilineInput('Comment for this step', '', snippet);
      if (!comment) { return; }

      const range: SerializedRange = {
        startLine: selection.start.line,
        startChar: selection.start.character,
        endLine: selection.end.line,
        endChar: selection.end.character,
      };

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

      const ann = await store.addAnnotation(relativePath, range, comment);
      await store.addStepToFlow(flowId, { annotationId: ann.id });

      const flow = store.getFlow(flowId);
      vscode.window.showInformationMessage(
        `Added step ${flow?.steps.length} to "${flow?.name}"`
      );
    })
  );

  // Remove from Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.removeFromFlow', async (item?: StepItem) => {
      if (item instanceof StepItem) {
        await store.removeStepFromFlow(item.flowId, item.stepIndex);
      }
    })
  );

  // Move Up / Down
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.moveUp', async (item?: StepItem) => {
      if (item instanceof StepItem) {
        await store.moveStep(item.flowId, item.stepIndex, 'up');
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.moveDown', async (item?: StepItem) => {
      if (item instanceof StepItem) {
        await store.moveStep(item.flowId, item.stepIndex, 'down');
      }
    })
  );

  // Go to Annotation (click handler from tree view)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.goToAnnotation', async (ann: Annotation) => {
      const absPath = path.join(workspaceRoot, ann.filePath);
      const uri = vscode.Uri.file(absPath);
      const range = new vscode.Range(
        ann.range.startLine,
        ann.range.startChar,
        ann.range.endLine,
        ann.range.endChar
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        selection: range,
        preserveFocus: false,
      });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    })
  );

  // Edit Annotation Comment (flow step)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.editAnnotationComment', async (item?: StepItem) => {
      if (!(item instanceof StepItem)) { return; }
      const ann = store.getAnnotation(item.annotation.id);
      if (!ann) { return; }

      const newComment = await getMultilineInput('Edit annotation', ann.comment);
      if (newComment !== undefined) {
        await store.updateAnnotationComment(ann.id, newComment);
      }
    })
  );

  // Edit Note (loose annotation)
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.editNote', async (item?: LooseAnnotationItem) => {
      if (!(item instanceof LooseAnnotationItem)) { return; }
      const ann = store.getAnnotation(item.annotation.id);
      if (!ann) { return; }

      const newComment = await getMultilineInput('Edit note', ann.comment);
      if (newComment !== undefined) {
        await store.updateAnnotationComment(ann.id, newComment);
      }
    })
  );

  // Export Flow to Markdown
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.exportFlow', async (item?: any) => {
      const flowId = item?.flow?.id || await pickFlow(store, 'Export which flow?');
      if (!flowId) { return; }
      const flow = store.getFlow(flowId);
      if (!flow) { return; }

      const markdown = await exporter.exportFlow(flow);
      await showOrSaveMarkdown(markdown, flow.name, workspaceRoot);
    })
  );

  // Export All Flows
  context.subscriptions.push(
    vscode.commands.registerCommand('carabiner.exportAllFlows', async () => {
      const projects = store.getAllProjects();

      let markdown: string;
      let baseName: string;

      if (projects.length > 0) {
        // Offer scope picker
        const scopeItems: { label: string; id: string | null }[] = [
          { label: '$(book) All projects', id: null },
          ...projects.map((p) => ({ label: `$(folder) ${p.name}`, id: p.id })),
        ];
        const picked = await vscode.window.showQuickPick(scopeItems, {
          placeHolder: 'Export scope — all projects or a specific one?',
        });
        if (!picked) { return; }

        if (picked.id === null) {
          markdown = await exporter.exportAllFlows();
          baseName = 'carabiner-report';
        } else {
          const project = store.getProject(picked.id)!;
          markdown = await exporter.exportProject(picked.id);
          baseName = `carabiner-${project.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        }
      } else {
        markdown = await exporter.exportAllFlows();
        baseName = 'carabiner-report';
      }

      await showOrSaveMarkdown(markdown, baseName, workspaceRoot);
    })
  );

  // ── Cleanup ────────────────────────────────────────────────

  context.subscriptions.push(treeView, decorations);
}

// ── Helpers ────────────────────────────────────────────────────

async function pickFlow(store: Store, placeholder: string): Promise<string | undefined> {
  const flows = store.getAllFlows();  if (flows.length === 0) {
    const create = await vscode.window.showInformationMessage(
      'No flows yet. Create one?',
      'Create Flow'
    );
    if (create) {
      await vscode.commands.executeCommand('carabiner.createFlow');
    }
    return undefined;
  }

  const items = flows.map((f) => ({
    label: `📍 ${f.name}`,
    description: `${f.steps.length} steps`,
    id: f.id,
  }));

  const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  return picked?.id;
}

/** Returns a projectId (or undefined if "None") or null if cancelled. Pass allowNone=true to include a "Remove from project" option. */
async function pickProject(store: Store, allowNone = false): Promise<string | null | undefined> {
  const projects = store.getAllProjects();
  if (projects.length === 0) { return undefined; }

  const items: { label: string; id: string | null }[] = projects.map((p) => ({
    label: `$(folder) ${p.name}`,
    id: p.id,
  }));
  if (allowNone) {
    items.unshift({ label: '$(circle-slash) No project (unassign)', id: null });
  } else {
    items.unshift({ label: '$(dash) Skip (no project)', id: '' });
  }

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Assign to project?' });
  if (!picked) { return undefined; }   // cancelled
  return picked.id || undefined;        // '' → undefined (skip), null → null (unassign)
}

async function pickProjectFull(store: Store) {
  const projects = store.getAllProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage('No projects yet.');
    return undefined;
  }
  const items = projects.map((p) => ({ label: `$(folder) ${p.name}`, project: p }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select project' });
  return picked?.project;
}

async function showOrSaveMarkdown(
  markdown: string,
  baseName: string,
  workspaceRoot: string
): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: '� Save to .carabiner/', value: 'save' },
      { label: '📋 Copy to clipboard', value: 'clipboard' },
    ],
    { placeHolder: 'What to do with the export?' }
  );

  if (!action) { return; }

  if (action.value === 'save') {
    const fileName = `${baseName.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`;
    const filePath = path.join(workspaceRoot, '.carabiner', fileName);
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf-8'));
    vscode.window.showInformationMessage(`Saved to .carabiner/${fileName}`);

    // Open it
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } else if (action.value === 'clipboard') {
    await vscode.env.clipboard.writeText(markdown);
    vscode.window.showInformationMessage('Markdown copied to clipboard.');
  }
}

async function getMultilineInput(
  prompt: string,
  initialContent = '',
  snippet?: { code: string; lang: string }
): Promise<string | undefined> {
  return new Promise(async (resolve) => {
    const disposables: vscode.Disposable[] = [];
    let resolved = false;

    const finish = (value: string | undefined) => {
      if (resolved) { return; }
      resolved = true;
      pendingConfirm = undefined;
      vscode.commands.executeCommand('setContext', 'carabiner.annotationPending', false);
      disposables.forEach(d => d.dispose());
      resolve(value);
    };

    // Build initial content: user types above the snippet, separated by a blank line
    let prefill = initialContent;
    if (snippet) {
      const sep = initialContent ? '\n\n' : '\n\n';
      prefill = initialContent + sep + `\`\`\`${snippet.lang}\n${snippet.code}\n\`\`\``;
    }

    // Open an empty untitled markdown doc, then inject content via editor.edit()
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown' });
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });

    if (prefill) {
      await editor.edit(edit => {
        edit.insert(new vscode.Position(0, 0), prefill);
      });
    }

    // Place cursor at the very top so the user types their annotation first
    const topPos = new vscode.Position(0, 0);
    editor.selection = new vscode.Selection(topPos, topPos);

    vscode.window.showInformationMessage(
      `${prompt} — Markdown supported. Press Ctrl+Enter or click "✓ Confirm" when done.`
    );

    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    bar.text = `$(check) Confirm Annotation`;
    bar.tooltip = 'Save annotation (Ctrl+Enter)';
    bar.command = 'carabiner.confirmAnnotation';
    bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    bar.show();
    disposables.push(bar);

    // Wire up the static confirm command via the module-level callback
    pendingConfirm = async () => {
      const text = doc.getText().trim();
      finish(text || undefined);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    };
    await vscode.commands.executeCommand('setContext', 'carabiner.annotationPending', true);

    const closeListener = vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed.uri.toString() === doc.uri.toString()) {
        finish(undefined);
      }
    });
    disposables.push(closeListener);
  });
}

export function deactivate() {}

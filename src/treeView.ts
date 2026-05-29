import * as vscode from 'vscode';
import { Store } from './store';
import { Flow, Annotation, Project } from './types';

/**
 * Sidebar tree view for the Carabiner panel.
 *
 * Structure (with projects):
 *   📁 Security Audit
 *     ├── 🔀 Auth Bypass Flow
 *     │     ├── 1. src/auth/login.py:42
 *     │     └── 2. src/db/query.py:91
 *     └── 📝 Notes (3)
 *           └── src/api/routes.py:18
 *
 * Without projects (backward compat), flows and notes appear at root level.
 */

export type TreeItem = ProjectItem | FlowItem | StepItem | LooseSectionItem | LooseAnnotationItem | ProjectNotesSectionItem;

export class ProjectItem extends vscode.TreeItem {
  constructor(public readonly project: Project, flowCount: number, noteCount: number) {
    super(project.name, vscode.TreeItemCollapsibleState.Expanded);
    const parts: string[] = [];
    if (flowCount > 0) { parts.push(`${flowCount} flow${flowCount !== 1 ? 's' : ''}`); }
    if (noteCount > 0) { parts.push(`${noteCount} note${noteCount !== 1 ? 's' : ''}`); }
    this.description = parts.join(', ') || 'empty';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'project';
    this.tooltip = `Project: ${project.name}`;
  }
}

export class ProjectNotesSectionItem extends vscode.TreeItem {
  constructor(public readonly projectId: string, count: number) {
    super('Notes', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon('bookmark');
    this.contextValue = 'projectNotesSection';
    this.tooltip = 'Notes in this project';
  }
}

export class LooseSectionItem extends vscode.TreeItem {
  constructor(count: number) {
    super('Notes', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon('bookmark');
    this.contextValue = 'looseSection';
    this.tooltip = 'Notes not assigned to any flow';
  }
}

export class LooseAnnotationItem extends vscode.TreeItem {
  constructor(public readonly annotation: Annotation) {
    const shortPath = annotation.filePath.split('/').slice(-2).join('/');
    const line = annotation.range.startLine + 1;
    super(`${shortPath}:${line}`, vscode.TreeItemCollapsibleState.None);

    const firstLine = annotation.comment.split('\n')[0];
    this.description = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
    this.tooltip = new vscode.MarkdownString(`**${annotation.filePath}:${line}**\n\n${annotation.comment}`);
    this.iconPath = new vscode.ThemeIcon('circle-outline');
    this.command = {
      command: 'carabiner.goToAnnotation',
      title: 'Go to Annotation',
      arguments: [annotation],
    };
    this.contextValue = 'looseAnnotation';
  }
}

export class FlowItem extends vscode.TreeItem {
  constructor(public readonly flow: Flow) {
    super(flow.name, vscode.TreeItemCollapsibleState.Expanded);

    this.description = `${flow.steps.length} steps`;
    this.iconPath = new vscode.ThemeIcon('git-merge');
    this.contextValue = 'flow';
  }
}

export class StepItem extends vscode.TreeItem {
  constructor(
    public readonly flowId: string,
    public readonly stepIndex: number,
    public readonly annotation: Annotation,
    note?: string
  ) {
    const shortPath = annotation.filePath.split('/').slice(-2).join('/');
    const line = annotation.range.startLine + 1; // 1-indexed for display
    const label = `${stepIndex + 1}. ${shortPath}:${line}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    // Show the first line of the comment (truncated) as description
    const firstLine = annotation.comment.split('\n')[0];
    const commentPreview = firstLine.length > 60
      ? firstLine.slice(0, 57) + '...'
      : firstLine;
    this.description = commentPreview;

    // Tooltip with full comment + any step-level note
    const tooltipParts = [`**${annotation.filePath}:${line}**\n\n${annotation.comment}`];
    if (note) {
      tooltipParts.push(`\n\n*Step note:* ${note}`);
    }
    this.tooltip = new vscode.MarkdownString(tooltipParts.join(''));

    // Fixed icon for all steps
    this.iconPath = new vscode.ThemeIcon('circle-outline');

    // Click → navigate to the annotation
    this.command = {
      command: 'carabiner.goToAnnotation',
      title: 'Go to Annotation',
      arguments: [annotation],
    };

    this.contextValue = 'step';
  }
}

export class FlowTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: Store) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      const flows = this.store.getAllFlows();
      const allAnns = this.store.getAllAnnotations();
      const projects = this.store.getAllProjects();

      const referencedIds = new Set<string>();
      for (const f of flows) { for (const s of f.steps) { referencedIds.add(s.annotationId); } }
      const looseAnns = Object.values(allAnns).filter((a) => !referencedIds.has(a.id));

      const items: TreeItem[] = [];

      if (projects.length > 0) {
        // Project folders
        for (const project of projects) {
          const pFlows = flows.filter((f) => f.projectId === project.id);
          const pNotes = looseAnns.filter((a) => a.projectId === project.id);
          items.push(new ProjectItem(project, pFlows.length, pNotes.length));
        }
        // Unassigned flows (no projectId)
        for (const f of flows.filter((f) => !f.projectId)) {
          items.push(new FlowItem(f));
        }
        // Unassigned notes
        const unassignedNotes = looseAnns.filter((a) => !a.projectId);
        if (unassignedNotes.length > 0) {
          items.push(new LooseSectionItem(unassignedNotes.length));
        }
      } else {
        // No projects — flat layout (original behaviour)
        items.push(...flows.map((f) => new FlowItem(f)));
        if (looseAnns.length > 0) {
          items.push(new LooseSectionItem(looseAnns.length));
        }
      }

      return items;
    }

    if (element instanceof ProjectItem) {
      const flows = this.store.getAllFlows();
      const allAnns = this.store.getAllAnnotations();
      const referencedIds = new Set<string>();
      for (const f of flows) { for (const s of f.steps) { referencedIds.add(s.annotationId); } }
      const looseAnns = Object.values(allAnns).filter((a) => !referencedIds.has(a.id));

      const pFlows = flows.filter((f) => f.projectId === element.project.id);
      const pNotes = looseAnns.filter((a) => a.projectId === element.project.id);

      const items: TreeItem[] = pFlows.map((f) => new FlowItem(f));
      if (pNotes.length > 0) {
        items.push(new ProjectNotesSectionItem(element.project.id, pNotes.length));
      }
      return items;
    }

    if (element instanceof ProjectNotesSectionItem) {
      const allAnns = this.store.getAllAnnotations();
      const referencedIds = new Set<string>();
      for (const f of this.store.getAllFlows()) { for (const s of f.steps) { referencedIds.add(s.annotationId); } }
      return Object.values(allAnns)
        .filter((a) => !referencedIds.has(a.id) && a.projectId === element.projectId)
        .map((a) => new LooseAnnotationItem(a));
    }

    if (element instanceof FlowItem) {
      // Flow children: list steps with resolved annotations
      const flow = element.flow;
      return flow.steps
        .map((step, idx) => {
          const ann = this.store.getAnnotation(step.annotationId);
          if (!ann) { return null; }
          return new StepItem(flow.id, idx, ann, step.note);
        })
        .filter((item): item is StepItem => item !== null);
    }

    if (element instanceof LooseSectionItem) {
      const allAnns = this.store.getAllAnnotations();
      const referencedIds = new Set<string>();
      for (const f of this.store.getAllFlows()) { for (const s of f.steps) { referencedIds.add(s.annotationId); } }
      return Object.values(allAnns)
        .filter((a) => !referencedIds.has(a.id))
        .map((a) => new LooseAnnotationItem(a));
    }

    return [];
  }

  getParent(element: TreeItem): TreeItem | undefined {
    if (element instanceof StepItem) {
      const flow = this.store.getFlow(element.flowId);
      if (flow) { return new FlowItem(flow); }
    }
    if (element instanceof LooseAnnotationItem) {
      const allAnns = this.store.getAllAnnotations();
      const referencedIds = new Set<string>();
      for (const f of this.store.getAllFlows()) { for (const s of f.steps) { referencedIds.add(s.annotationId); } }
      const loose = Object.values(allAnns).filter((a) => !referencedIds.has(a.id));
      return new LooseSectionItem(loose.length);
    }
    return undefined;
  }
}

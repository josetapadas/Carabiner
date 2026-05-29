import * as vscode from 'vscode';
import * as path from 'path';
import {
  Annotation,
  CarabinerData,
  Flow,
  FlowStep,
  Project,
  SerializedRange,
  createEmptyData,
} from './types';

/**
 * Store manages all carabiner data for the current workspace.
 *
 * Data lives in `.carabiner/data.json` at the workspace root so it can be
 * committed to the repo (useful for sharing flow annotations in PRs) or
 * git-ignored if you prefer local-only notes.
 *
 * Every mutation fires `onDidChange` so the tree view and decorations
 * can react.
 */
export class Store {
  private data: CarabinerData = createEmptyData();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private workspaceRoot: string) {}

  // ── Persistence ──────────────────────────────────────────────

  private get filePath(): string {
    return path.join(this.workspaceRoot, '.carabiner', 'data.json');
  }

  async load(): Promise<void> {
    try {
      const uri = vscode.Uri.file(this.filePath);
      const raw = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
      // Migrate old data that may not have projects field
      this.data = { projects: [], ...parsed };
    } catch {
      this.data = createEmptyData();
    }
  }

  async save(): Promise<void> {
    const uri = vscode.Uri.file(this.filePath);
    // Ensure .carabiner/ directory exists
    const dir = vscode.Uri.file(path.dirname(this.filePath));
    await vscode.workspace.fs.createDirectory(dir);
    const content = Buffer.from(JSON.stringify(this.data, null, 2), 'utf-8');
    await vscode.workspace.fs.writeFile(uri, content);
    this._onDidChange.fire();
  }

  // ── Annotations ──────────────────────────────────────────────

  getAllAnnotations(): Record<string, Annotation> {
    return this.data.annotations;
  }

  getAnnotation(id: string): Annotation | undefined {
    return this.data.annotations[id];
  }

  async addAnnotation(
    filePath: string,
    range: SerializedRange,
    comment: string,
    projectId?: string
  ): Promise<Annotation> {
    const id = this.generateId();
    const annotation: Annotation = {
      id,
      filePath,
      range,
      comment,
      ...(projectId ? { projectId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.data.annotations[id] = annotation;
    await this.save();
    return annotation;
  }

  async updateAnnotationComment(id: string, comment: string): Promise<void> {
    const ann = this.data.annotations[id];
    if (ann) {
      ann.comment = comment;
      await this.save();
    }
  }

  async removeAnnotation(id: string): Promise<void> {
    delete this.data.annotations[id];
    // Also remove from any flows that reference it
    for (const flow of this.data.flows) {
      flow.steps = flow.steps.filter((s) => s.annotationId !== id);
    }
    await this.save();
  }

  // ── Flows ────────────────────────────────────────────────────

  getAllFlows(): Flow[] {
    return this.data.flows;
  }

  getFlow(id: string): Flow | undefined {
    return this.data.flows.find((f) => f.id === id);
  }

  async createFlow(name: string, projectId?: string): Promise<Flow> {
    const now = new Date().toISOString();
    const flow: Flow = {
      id: this.generateId(),
      name,
      steps: [],
      ...(projectId ? { projectId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.data.flows.push(flow);
    await this.save();
    return flow;
  }

  async deleteFlow(id: string): Promise<void> {
    this.data.flows = this.data.flows.filter((f) => f.id !== id);
    await this.save();
  }

  async renameFlow(id: string, name: string): Promise<void> {
    const flow = this.getFlow(id);
    if (flow) {
      flow.name = name;
      flow.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  async setFlowDescription(id: string, description: string): Promise<void> {
    const flow = this.getFlow(id);
    if (flow) {
      flow.description = description;
      flow.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  async addStepToFlow(flowId: string, step: FlowStep): Promise<void> {
    const flow = this.getFlow(flowId);
    if (flow) {
      flow.steps.push(step);
      flow.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  async removeStepFromFlow(flowId: string, index: number): Promise<void> {
    const flow = this.getFlow(flowId);
    if (flow && index >= 0 && index < flow.steps.length) {
      flow.steps.splice(index, 1);
      flow.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  async moveStep(flowId: string, fromIndex: number, direction: 'up' | 'down'): Promise<void> {
    const flow = this.getFlow(flowId);
    if (!flow) { return; }
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= flow.steps.length) { return; }
    const [step] = flow.steps.splice(fromIndex, 1);
    flow.steps.splice(toIndex, 0, step);
    flow.updatedAt = new Date().toISOString();
    await this.save();
  }

  async setFlowProject(flowId: string, projectId: string | undefined): Promise<void> {
    const flow = this.getFlow(flowId);
    if (flow) {
      flow.projectId = projectId;
      flow.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  async setAnnotationProject(annId: string, projectId: string | undefined): Promise<void> {
    const ann = this.data.annotations[annId];
    if (ann) {
      ann.projectId = projectId;
      await this.save();
    }
  }

  // ── Projects ──────────────────────────────────────────

  getAllProjects(): Project[] {
    return this.data.projects;
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  async createProject(name: string): Promise<Project> {
    const project: Project = {
      id: this.generateId(),
      name,
      createdAt: new Date().toISOString(),
    };
    this.data.projects.push(project);
    await this.save();
    return project;
  }

  async renameProject(id: string, name: string): Promise<void> {
    const project = this.getProject(id);
    if (project) {
      project.name = name;
      await this.save();
    }
  }

  async deleteProject(id: string): Promise<void> {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    // Unassign items belonging to this project
    for (const flow of this.data.flows) {
      if (flow.projectId === id) { delete flow.projectId; }
    }
    for (const ann of Object.values(this.data.annotations)) {
      if (ann.projectId === id) { delete ann.projectId; }
    }
    await this.save();
  }

  // ── Helpers ──────────────────────────────────────────────────

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

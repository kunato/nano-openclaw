import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private memories: MemoryEntry[] = [];
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, "memory", "memory.json");
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      this.memories = JSON.parse(data);
    } catch {
      this.memories = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.memories, null, 2));
  }

  async store(content: string, tags: string[] = []): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      content,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.memories.push(entry);
    await this.save();
    return entry;
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const lower = query.toLowerCase();
    return this.memories.filter(
      (m) =>
        m.content.toLowerCase().includes(lower) ||
        m.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  async list(): Promise<MemoryEntry[]> {
    return [...this.memories];
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.memories.splice(idx, 1);
    await this.save();
    return true;
  }

  async update(
    id: string,
    content: string,
    tags?: string[],
  ): Promise<MemoryEntry | null> {
    const entry = this.memories.find((m) => m.id === id);
    if (!entry) return null;
    entry.content = content;
    if (tags) entry.tags = tags;
    entry.updatedAt = new Date().toISOString();
    await this.save();
    return entry;
  }
}

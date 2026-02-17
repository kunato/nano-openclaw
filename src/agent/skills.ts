import fs from "node:fs/promises";
import path from "node:path";

export interface LoadedSkill {
  name: string;
  content: string;
}

/**
 * Scan workspace for skill files: skills/*.md and skills/x/SKILL.md.
 * Mirrors OpenClaw's skills system: each skill is a markdown file with
 * specialized instructions the agent can follow for specific tasks.
 */
export async function loadWorkspaceSkills(workspaceDir: string): Promise<LoadedSkill[]> {
  const skillsDir = path.join(workspaceDir, "skills");
  const skills: LoadedSkill[] = [];

  try {
    await fs.access(skillsDir);
  } catch {
    return skills;
  }

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(skillsDir, entry.name);

      if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readSkillFile(fullPath);
        if (content) {
          const name = entry.name.replace(/\.md$/i, "");
          skills.push({ name, content });
        }
      } else if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, "SKILL.md");
        const content = await readSkillFile(skillFile);
        if (content) {
          skills.push({ name: entry.name, content });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[skills] Error scanning skills directory: " + msg);
  }

  if (skills.length > 0) {
    const names = skills.map((s) => s.name).join(", ");
    console.log("[skills] Loaded " + skills.length + " skill(s): " + names);
  }

  return skills;
}

async function readSkillFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Load AGENTS.md / bootstrap context from workspace root.
 * OpenClaw loads these to customize agent behavior per project.
 */
export async function loadBootstrapContext(workspaceDir: string): Promise<string | null> {
  const candidates = ["AGENTS.md", "CLAUDE.md", ".agents.md"];
  for (const name of candidates) {
    const filePath = path.join(workspaceDir, name);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed) {
        console.log("[skills] Loaded bootstrap context from " + name);
        return trimmed;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Format loaded skills into a system prompt section.
 */
export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map(
    (s) => "### Skill: " + s.name + "\n" + s.content,
  );

  return [
    "## Skills",
    "You have access to the following specialized skill instructions. Use them when the task matches.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

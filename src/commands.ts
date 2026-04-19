import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

export interface Command {
  name: string
  description: string
  builtin: boolean
}

// Built-in commands (hardcoded - comprehensive list from Claude Code docs)
const BUILTIN_COMMANDS: Command[] = [
  // Essential Commands
  { name: 'help', description: 'List all available commands', builtin: true },
  { name: 'init', description: 'Create CLAUDE.md file for project', builtin: true },
  { name: 'review', description: 'Review uncommitted code changes', builtin: true },
  { name: 'compact', description: 'Compress conversation to free context', builtin: true },
  { name: 'cost', description: 'Show token usage and costs', builtin: true },
  { name: 'clear', description: 'Clear conversation history', builtin: true },
  { name: 'exit', description: 'Exit the interactive session', builtin: true },

  // Session & Navigation
  { name: 'resume', description: 'Resume previous conversation', builtin: true },
  { name: 'rename', description: 'Rename current session', builtin: true },
  { name: 'add-dir', description: 'Add directory to context', builtin: true },
  { name: 'context', description: 'Visualize context window usage', builtin: true },
  { name: 'rewind', description: 'Undo messages and revert changes', builtin: true },

  // Configuration
  { name: 'config', description: 'Open settings interface', builtin: true },
  { name: 'model', description: 'Switch Claude model', builtin: true },
  { name: 'permissions', description: 'Manage tool permissions', builtin: true },
  { name: 'theme', description: 'Switch color theme', builtin: true },
  { name: 'output-style', description: 'Configure response formatting', builtin: true },

  // Memory & Project
  { name: 'memory', description: 'Edit memory and project context', builtin: true },
  { name: 'todos', description: 'List tracked TODO items', builtin: true },
  { name: 'pr-comments', description: 'View pull request comments', builtin: true },

  // Integration
  { name: 'mcp', description: 'Manage MCP connections', builtin: true },
  { name: 'ide', description: 'Manage IDE integrations', builtin: true },
  { name: 'install-github-app', description: 'Setup GitHub Actions', builtin: true },

  // Agent & Automation
  { name: 'agents', description: 'Manage custom sub-agents', builtin: true },
  { name: 'hooks', description: 'Configure automated actions', builtin: true },
  { name: 'plugin', description: 'Manage plugins', builtin: true },
  { name: 'bashes', description: 'List background tasks', builtin: true },

  // Utility
  { name: 'doctor', description: 'Run installation diagnostics', builtin: true },
  { name: 'bug', description: 'Report a bug to Anthropic', builtin: true },
  { name: 'export', description: 'Export conversation to file', builtin: true },
  { name: 'status', description: 'View system information', builtin: true },
  { name: 'release-notes', description: 'View version release notes', builtin: true },
  { name: 'stats', description: 'View usage statistics', builtin: true },

  // Account
  { name: 'login', description: 'Log in to Anthropic account', builtin: true },
  { name: 'logout', description: 'Sign out from account', builtin: true },
  { name: 'usage', description: 'View subscription limits', builtin: true },
  { name: 'privacy-settings', description: 'Update privacy configuration', builtin: true },

  // Advanced
  { name: 'plan', description: 'Enter read-only planning mode', builtin: true },
  { name: 'vim', description: 'Toggle Vim-style editing', builtin: true },
  { name: 'sandbox', description: 'Enable sandboxed execution', builtin: true },
  { name: 'security-review', description: 'Audit for vulnerabilities', builtin: true },
  { name: 'terminal-setup', description: 'Install terminal shortcuts', builtin: true },
  { name: 'statusline', description: 'Configure terminal status line', builtin: true },
  { name: 'teleport', description: 'Resume remote sessions', builtin: true },
  { name: 'remote-env', description: 'Configure remote environment', builtin: true },
]

/**
 * Parse YAML frontmatter from a SKILL.md file
 * Format:
 * ---
 * name: skill-name
 * description: When to use this skill
 * ---
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  match[1].split('\n').forEach(line => {
    const colonIndex = line.indexOf(':')
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      frontmatter[key] = value
    }
  })
  return frontmatter
}

/**
 * Parse a SKILL.md file and return a Command object
 */
async function parseSkillFile(filePath: string, skillName: string): Promise<Command | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const frontmatter = parseFrontmatter(content)

    return {
      name: frontmatter.name || skillName,
      description: frontmatter.description || 'No description',
      builtin: false
    }
  } catch {
    return null
  }
}

// Reject directory/file names that try to smuggle path separators.
function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

/**
 * Scan a directory for skill subdirectories with SKILL.md files
 */
async function scanSkillDirectory(dirPath: string): Promise<Command[]> {
  const commands: Command[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue
      const skillPath = path.join(dirPath, entry.name, 'SKILL.md')
      const command = await parseSkillFile(skillPath, entry.name)
      if (command) {
        commands.push(command)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable - that's fine
  }

  return commands
}

/**
 * Scan legacy commands directory (.claude/commands/*.md)
 */
async function scanLegacyCommands(dirPath: string): Promise<Command[]> {
  const commands: Command[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && isSafeEntryName(entry.name)) {
        const name = entry.name.replace(/\.md$/, '')
        const filePath = path.join(dirPath, entry.name)

        try {
          const content = await fs.readFile(filePath, 'utf-8')
          const frontmatter = parseFrontmatter(content)

          commands.push({
            name: frontmatter.name || name,
            description: frontmatter.description || 'Custom command',
            builtin: false
          })
        } catch {
          commands.push({
            name,
            description: 'Custom command',
            builtin: false
          })
        }
      }
    }
  } catch {
    // Directory doesn't exist - that's fine
  }

  return commands
}

/**
 * Scan plugin directories for skills
 */
async function scanPluginSkills(pluginsDir: string): Promise<Command[]> {
  const commands: Command[] = []

  try {
    const plugins = await fs.readdir(pluginsDir, { withFileTypes: true })

    for (const plugin of plugins) {
      if (!plugin.isDirectory() || !isSafeEntryName(plugin.name)) continue
      const skillsDir = path.join(pluginsDir, plugin.name, 'skills')
      const pluginCommands = await scanSkillDirectory(skillsDir)
      commands.push(...pluginCommands)
    }
  } catch {
    // Plugins directory doesn't exist - that's fine
  }

  return commands
}

/**
 * Get all available commands from all sources
 * @param projectCwd Optional project directory to scan for project-specific commands
 */
export async function getAllCommands(projectCwd?: string): Promise<Command[]> {
  const homeDir = os.homedir()
  const projectDir = projectCwd || process.cwd()

  // Paths to scan
  const userSkillsDir = path.join(homeDir, '.claude', 'skills')
  const projectSkillsDir = path.join(projectDir, '.claude', 'skills')
  const pluginsDir = path.join(homeDir, '.claude', 'plugins')
  const legacyCommandsDir = path.join(projectDir, '.claude', 'commands')

  // Scan all directories in parallel
  const [userSkills, projectSkills, pluginSkills, legacyCommands] = await Promise.all([
    scanSkillDirectory(userSkillsDir),
    scanSkillDirectory(projectSkillsDir),
    scanPluginSkills(pluginsDir),
    scanLegacyCommands(legacyCommandsDir)
  ])

  // Combine all commands, with built-ins first
  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...userSkills,
    ...projectSkills,
    ...pluginSkills,
    ...legacyCommands
  ]

  // Remove duplicates by name (keep first occurrence)
  const seen = new Set<string>()
  const uniqueCommands = allCommands.filter(cmd => {
    if (seen.has(cmd.name)) return false
    seen.add(cmd.name)
    return true
  })

  return uniqueCommands
}

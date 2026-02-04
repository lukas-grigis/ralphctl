import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

interface SettingsFile {
  permissions?: PermissionsConfig;
}

export interface ClaudePermissions {
  allow: string[];
  deny: string[];
}

/**
 * Get Claude permissions from settings files.
 * Checks project-level settings first, then falls back to user-level.
 *
 * @param projectPath - Project directory to check for .claude/settings.local.json
 * @returns Combined permissions from both sources
 */
export function getClaudePermissions(projectPath: string): ClaudePermissions {
  const permissions: ClaudePermissions = {
    allow: [],
    deny: [],
  };

  // Check project-level settings (.claude/settings.local.json)
  const projectSettingsPath = join(projectPath, '.claude', 'settings.local.json');
  if (existsSync(projectSettingsPath)) {
    try {
      const content = readFileSync(projectSettingsPath, 'utf-8');
      const settings = JSON.parse(content) as SettingsFile;
      if (settings.permissions?.allow) {
        permissions.allow.push(...settings.permissions.allow);
      }
      if (settings.permissions?.deny) {
        permissions.deny.push(...settings.permissions.deny);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check user-level settings (~/.claude/settings.json)
  const userSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(userSettingsPath)) {
    try {
      const content = readFileSync(userSettingsPath, 'utf-8');
      const settings = JSON.parse(content) as SettingsFile;
      if (settings.permissions?.allow) {
        permissions.allow.push(...settings.permissions.allow);
      }
      if (settings.permissions?.deny) {
        permissions.deny.push(...settings.permissions.deny);
      }
    } catch {
      // Ignore parse errors
    }
  }

  return permissions;
}

/**
 * Check if a specific tool/command is allowed in permissions.
 *
 * Permission patterns:
 * - "Bash(command:*)" - matches "Bash" tool with command starting with "command"
 * - "Bash(git commit:*)" - matches git commit with any message
 * - "Bash(*)" - matches any Bash command
 *
 * @returns true if explicitly allowed, false if denied, 'ask' if no match
 */
export function isToolAllowed(permissions: ClaudePermissions, tool: string, specifier?: string): boolean | 'ask' {
  // Check deny list first (deny takes precedence)
  for (const pattern of permissions.deny) {
    if (matchesPattern(pattern, tool, specifier)) {
      return false;
    }
  }

  // Check allow list
  for (const pattern of permissions.allow) {
    if (matchesPattern(pattern, tool, specifier)) {
      return true;
    }
  }

  // No explicit permission - will ask
  return 'ask';
}

/**
 * Match a permission pattern against a tool call.
 *
 * Pattern formats:
 * - "ToolName" - matches tool name exactly
 * - "ToolName(specifier)" - matches exact specifier
 * - "ToolName(prefix*)" - matches specifier starting with prefix
 * - "ToolName(*)" - matches any specifier for this tool
 */
function matchesPattern(pattern: string, tool: string, specifier?: string): boolean {
  // Parse pattern
  const parenIdx = pattern.indexOf('(');

  if (parenIdx === -1) {
    // Pattern is just tool name
    return pattern === tool;
  }

  const patternTool = pattern.slice(0, parenIdx);
  if (patternTool !== tool) {
    return false;
  }

  // Extract specifier pattern (remove parentheses)
  const specPattern = pattern.slice(parenIdx + 1, -1);

  if (specPattern === '*') {
    // Matches any specifier
    return true;
  }

  if (!specifier) {
    return false;
  }

  if (specPattern.endsWith(':*')) {
    // Prefix match (e.g., "git commit:*" matches "git commit -m 'msg'")
    const prefix = specPattern.slice(0, -2);
    return specifier.startsWith(prefix);
  }

  if (specPattern.endsWith('*')) {
    // Simple prefix match
    const prefix = specPattern.slice(0, -1);
    return specifier.startsWith(prefix);
  }

  // Exact match
  return specPattern === specifier;
}

export interface PermissionWarning {
  tool: string;
  specifier?: string;
  message: string;
}

/**
 * Check permissions for common operations needed during task execution.
 *
 * @returns Array of warnings for operations that may need approval
 */
export function checkTaskPermissions(
  projectPath: string,
  options: {
    verifyScript?: string | null;
    setupScript?: string | null;
    needsCommit?: boolean;
  }
): PermissionWarning[] {
  const warnings: PermissionWarning[] = [];
  const permissions = getClaudePermissions(projectPath);

  // Check git commit permission
  if (options.needsCommit !== false) {
    const commitAllowed = isToolAllowed(permissions, 'Bash', 'git commit');
    if (commitAllowed !== true) {
      warnings.push({
        tool: 'Bash',
        specifier: 'git commit',
        message: 'Git commits may require manual approval',
      });
    }
  }

  // Check verify script permission
  if (options.verifyScript) {
    const verifyAllowed = isToolAllowed(permissions, 'Bash', options.verifyScript);
    if (verifyAllowed !== true) {
      warnings.push({
        tool: 'Bash',
        specifier: options.verifyScript,
        message: `Verify script "${options.verifyScript}" may require approval`,
      });
    }
  }

  // Check setup script permission
  if (options.setupScript) {
    const setupAllowed = isToolAllowed(permissions, 'Bash', options.setupScript);
    if (setupAllowed !== true) {
      warnings.push({
        tool: 'Bash',
        specifier: options.setupScript,
        message: `Setup script "${options.setupScript}" may require approval`,
      });
    }
  }

  return warnings;
}

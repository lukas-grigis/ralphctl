import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Result } from 'typescript-result';
import type { AiProvider } from '@src/domain/models.ts';

interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

interface SettingsFile {
  permissions?: PermissionsConfig;
}

export interface ProviderPermissions {
  allow: string[];
  deny: string[];
}

/**
 * Get AI provider permissions from settings files.
 * For Claude: checks .claude/settings.local.json and ~/.claude/settings.json
 * For Copilot: returns empty permissions (all tools granted via --allow-all-tools flag)
 *
 * @param projectPath - Project directory to check for settings
 * @param provider - AI provider (defaults to 'claude')
 * @returns Combined permissions from both sources
 */
export function getProviderPermissions(projectPath: string, provider?: AiProvider): ProviderPermissions {
  const permissions: ProviderPermissions = {
    allow: [],
    deny: [],
  };

  // Copilot manages permissions via CLI flags, not settings files
  if (provider === 'copilot') {
    return permissions;
  }

  // Check project-level settings (.claude/settings.local.json)
  const projectSettingsPath = join(projectPath, '.claude', 'settings.local.json');
  if (existsSync(projectSettingsPath)) {
    const projectResult = Result.try(() => {
      const content = readFileSync(projectSettingsPath, 'utf-8');
      return JSON.parse(content) as SettingsFile;
    });
    if (projectResult.ok) {
      const settings = projectResult.value;
      if (settings.permissions?.allow) {
        permissions.allow.push(...settings.permissions.allow);
      }
      if (settings.permissions?.deny) {
        permissions.deny.push(...settings.permissions.deny);
      }
    }
  }

  // Check user-level settings (~/.claude/settings.json)
  const userSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(userSettingsPath)) {
    const userResult = Result.try(() => {
      const content = readFileSync(userSettingsPath, 'utf-8');
      return JSON.parse(content) as SettingsFile;
    });
    if (userResult.ok) {
      const settings = userResult.value;
      if (settings.permissions?.allow) {
        permissions.allow.push(...settings.permissions.allow);
      }
      if (settings.permissions?.deny) {
        permissions.deny.push(...settings.permissions.deny);
      }
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
export function isToolAllowed(permissions: ProviderPermissions, tool: string, specifier?: string): boolean | 'ask' {
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
 * For Claude: reads settings files and warns about operations that may need approval.
 * For Copilot: returns no warnings (all tools granted via --allow-all-tools).
 *
 * @returns Array of warnings for operations that may need approval
 */
export function checkTaskPermissions(
  projectPath: string,
  options: {
    checkScript?: string | null;
    needsCommit?: boolean;
    provider?: AiProvider;
  }
): PermissionWarning[] {
  const warnings: PermissionWarning[] = [];

  // Copilot manages permissions via --allow-all-tools — no warnings needed
  if (options.provider === 'copilot') {
    return warnings;
  }

  const permissions = getProviderPermissions(projectPath, options.provider);

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

  // Check check script permission
  if (options.checkScript) {
    const checkAllowed = isToolAllowed(permissions, 'Bash', options.checkScript);
    if (checkAllowed !== true) {
      warnings.push({
        tool: 'Bash',
        specifier: options.checkScript,
        message: `Check script "${options.checkScript}" may require approval`,
      });
    }
  }

  return warnings;
}

---
name: seams_skill_folders_and_frontmatter
description: Skill folder install/hash/contract seams and the YAML frontmatter parser traps — what must not change and why
metadata:
  type: project
---

- `hashSkillFolder` with zero support files MUST equal `hashSkillContent(SKILL.md)`. **Why:** provenance stamps written before folder skills existed would otherwise all flip to `locally-modified` and block `updateAll`. **How to apply:** never fold a separator or file count into the empty-files case.
- The operator/phase contract guard is fed one pseudo-Skill per Markdown doc (`<skill>/<path>`) from the loader. **Why:** `application/ui/shared/launcher.ts` (not implementer scope) calls `checkContract(logger, skill.name, skill.content)` and never sees `files`. Moving the scan into the launcher needs a designer-side edit.
- S8 (`{{UPPER_SNAKE}}` placeholders) is non-negatable and case-sensitive. **Why:** the bug it fences reads "never hardcode commands; use {{PROJECT_TOOLING}}" — negation demotion would excuse exactly that. Lowercase `{{ user.name }}` stays legal for view-template examples.
- S4 lists command _invocations_ (`mvn test`, `gradlew test`), not bare tool names: TDD skill legitimately says "prefer `./gradlew`".
- `parseYamlFrontmatter` retries once with unparseable single-line top-level values JSON-quoted (`description: Use when: X`). **Why:** published skills/agents ship that invalid YAML and the CLIs accept it; dropping them was a regression vs the old line reader. Don't widen the retry to indented/multi-line values — quoting one line of a continued scalar corrupts it. Agents parse with the same reader then `flattenFrontmatter`, so YAML errors are reported, not hidden as missing fields.
- `SkillFile.content` is text when UTF-8, bytes otherwise; `executable` rides along. Text goes through the injected string-typed `WriteFile`, but bytes and executables bypass it to `writeFileAtomic`. **Why:** widening the business `WriteFile` port would break every test fake (param contravariance). A fake WriteFile therefore never sees binary/exec writes. Symlinks and dotfiles are skipped on read — a symlink could pull files from outside the skill into a repo.
- Phase source skips folders whose `.provenance.json` names a skill no longer in `BUNDLED_SKILLS`; unstamped folders of the same name still load (operator-owned). The catalog keeps listing them as `manual` so they can be deleted.

#!/usr/bin/env node
'use strict';

// Installer for this repo's Claude Code skills — copies a skill's files
// from this package into ~/.claude/skills/<name>/, where Claude Code
// discovers skills automatically. Zero runtime dependencies deliberately:
// this only ever needs to run once per install via `npx`, so pulling in a
// dependency tree just for a CLI parser/prompt library would slow down
// every cold `npx` invocation for no real benefit.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const SKILLS_SOURCE_DIR = path.join(__dirname, '..', 'skills');
const DEFAULT_TARGET_DIR = path.join(os.homedir(), '.claude', 'skills');

function listAvailableSkills() {
  if (!fs.existsSync(SKILLS_SOURCE_DIR)) return [];
  return fs
    .readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_SOURCE_DIR, name, 'SKILL.md')))
    .sort();
}

function readSkillDescription(name) {
  const skillMdPath = path.join(SKILLS_SOURCE_DIR, name, 'SKILL.md');
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const match = content.match(/^description:\s*(.+)$/m);
  if (!match) return '';
  const raw = match[1].trim();
  const firstSentence = raw.split(/(?<=\.)\s/)[0];
  return firstSentence.length > 160 ? firstSentence.slice(0, 157) + '...' : firstSentence;
}

function promptYesNo(question, defaultYes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') return resolve(defaultYes);
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

function promptSelect(question, choices) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  choices.forEach((choice, i) => console.log(`  ${i + 1}) ${choice}`));
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      const index = parseInt(answer.trim(), 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) {
        return resolve(choices[index]);
      }
      resolve(null);
    });
  });
}

async function installSkill(name, targetDir, { force, yes } = {}) {
  const sourceDir = path.join(SKILLS_SOURCE_DIR, name);
  if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    console.error(`No skill named "${name}" in this package. Run with --list to see available skills.`);
    process.exitCode = 1;
    return false;
  }

  const destDir = path.join(targetDir, name);
  if (fs.existsSync(destDir)) {
    if (!force) {
      const proceed = yes
        ? true
        : await promptYesNo(`${destDir} already exists. Overwrite?`, false);
      if (!proceed) {
        console.log(`Skipped ${name} (left existing install untouched).`);
        return false;
      }
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });
  console.log(`Installed "${name}" -> ${destDir}`);
  return true;
}

function printHelp() {
  console.log(`
agent-skills — install Claude Code skills from this collection

Usage:
  npx @raheelsoft/agent-skills                 Interactively pick a skill to install
  npx @raheelsoft/agent-skills install <name>  Install a specific skill by name
  npx @raheelsoft/agent-skills install --all   Install every skill in this package
  npx @raheelsoft/agent-skills list            List available skills

Options:
  --dir <path>   Install into <path> instead of ~/.claude/skills
  --force        Overwrite an existing install without asking
  -y, --yes      Assume "yes" to any prompt (non-interactive)
  -h, --help     Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    force: args.includes('--force'),
    yes: args.includes('-y') || args.includes('--yes'),
    help: args.includes('-h') || args.includes('--help'),
    all: args.includes('--all'),
  };
  const dirFlagIndex = args.indexOf('--dir');
  const targetDir = dirFlagIndex !== -1 && args[dirFlagIndex + 1]
    ? path.resolve(args[dirFlagIndex + 1])
    : DEFAULT_TARGET_DIR;

  if (flags.help) return printHelp();

  const positional = args.filter((a, i) => {
    if (a.startsWith('-')) return false;
    if (i > 0 && args[i - 1] === '--dir') return false;
    return true;
  });
  const command = positional[0];
  const skills = listAvailableSkills();

  if (skills.length === 0) {
    console.error('No skills found in this package — nothing to install.');
    process.exitCode = 1;
    return;
  }

  if (command === 'list') {
    console.log('Available skills:');
    for (const name of skills) {
      const desc = readSkillDescription(name);
      console.log(`  ${name}${desc ? ' — ' + desc : ''}`);
    }
    return;
  }

  if (command === 'install') {
    if (flags.all) {
      for (const name of skills) await installSkill(name, targetDir, flags);
      return;
    }
    const names = positional.slice(1);
    if (names.length === 0) {
      console.error('Usage: npx @raheelsoft/agent-skills install <skill-name> (or --all)');
      process.exitCode = 1;
      return;
    }
    for (const name of names) await installSkill(name, targetDir, flags);
    return;
  }

  if (command) {
    console.error(`Unknown command "${command}".`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  // No command given: interactive picker (or install directly if there's
  // only one skill in the package — no point making that a menu of one).
  if (skills.length === 1) {
    await installSkill(skills[0], targetDir, flags);
    return;
  }

  const choice = await promptSelect('Which skill do you want to install?', skills);
  if (!choice) {
    console.log('No valid selection — nothing installed. Run with --help for other ways to invoke this.');
    process.exitCode = 1;
    return;
  }
  await installSkill(choice, targetDir, flags);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

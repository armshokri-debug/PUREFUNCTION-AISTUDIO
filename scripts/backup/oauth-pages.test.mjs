import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const backupToolDir = path.resolve(process.cwd(), 'public', 'backup-tool');
const homepagePath = path.join(backupToolDir, 'index.html');
const privacyPath = path.join(backupToolDir, 'privacy.html');

describe('PureFunction Backup static Google OAuth pages', () => {
  it('provides standalone Homepage and Privacy Policy HTML files under public/backup-tool/', () => {
    expect(fs.existsSync(homepagePath)).toBe(true);
    expect(fs.existsSync(privacyPath)).toBe(true);

    const homepage = fs.readFileSync(homepagePath, 'utf8');
    const privacy = fs.readFileSync(privacyPath, 'utf8');

    expect(homepage).toContain('<title>PureFunction Backup — Homepage</title>');
    expect(homepage).toContain('href="./privacy.html"');
    expect(homepage).toContain('https://www.googleapis.com/auth/drive.file');
    expect(homepage).toContain('AES-256-GCM');
    expect(homepage).toMatch(/separate from the pure function coaching app/i);

    expect(privacy).toContain('<title>PureFunction Backup — Privacy Policy</title>');
    expect(privacy).toContain('href="./index.html"');
    expect(privacy).toContain('https://www.googleapis.com/auth/drive.file');
    expect(privacy).toContain('PureFunction-Encrypted-Backups');
    expect(privacy).toContain('AES-256-GCM');
    expect(privacy).toContain('PFBK1');
    expect(privacy).toContain('30 days');
    expect(privacy).toContain('7 backups');
    expect(privacy).toContain('myaccount.google.com/permissions');
  });

  it('does not leak secrets, credentials, tokens, project refs, or client PII', () => {
    const combined =
      fs.readFileSync(homepagePath, 'utf8') + '\n' + fs.readFileSync(privacyPath, 'utf8');

    expect(combined).not.toMatch(/rugwzvztweiffprkxfdc/i);
    expect(combined).not.toMatch(/sb_publishable_|sb_secret_|service_role/i);
    expect(combined).not.toMatch(/\bya29\.[A-Za-z0-9._-]{10,}/);
    expect(combined).not.toMatch(/\b1\/\/[A-Za-z0-9._-]{10,}/);
    expect(combined).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(combined).not.toMatch(/\.apps\.googleusercontent\.com/i);
    expect(combined).not.toMatch(/@gmail\.com/i);
  });
});

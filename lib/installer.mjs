import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PLUGIN_ID, PLUGIN_VERSION } from './constants.mjs';
import { findActiveRuntime, stopExistingRuntimes } from './runtime-control.mjs';
import { writeJsonAtomically } from './settings.mjs';

const PACKAGE_INCLUDED_PATHS = [
  'plugin.json',
  'package.json',
  'LICENSE',
  'README.md',
  'install.ps1',
  'install.sh',
  'uninstall.ps1',
  'uninstall.sh',
  'assets',
  'docs',
  'lib',
  'scripts',
  'sidecars'
];

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function resolveInstallationPaths({ home = homedir(), env = process.env } = {}) {
  const normalizedHome = resolve(home);
  const geminiRoot = join(normalizedHome, '.gemini');
  const appDataDir = env.ANTIGRAVITY_APP_DATA_DIR || join(geminiRoot, 'antigravity');
  return {
    home: normalizedHome,
    geminiRoot,
    installedPluginDir: join(geminiRoot, 'config', 'plugins', PLUGIN_ID),
    pluginDataDir: join(appDataDir, 'plugin_data', PLUGIN_ID),
    sidecarDataDir: join(appDataDir, 'sidecar_data', PLUGIN_ID),
    runtimeDir: join(appDataDir, 'plugin_data', PLUGIN_ID, 'runtime')
  };
}

export function assertPathInsideRoot(rootDir, targetPath) {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `Target path outside root: ${targetPath}`);
  if (existsSync(resolvedRoot) && lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error('Root directory must not be a symlink');
  }
  return resolvedTarget;
}

function collectFilesRecursively(baseDir, subPath = '') {
  const fullPath = subPath ? join(baseDir, subPath) : baseDir;
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symlink in package tree: ${fullPath}`);
  }
  if (stat.isFile()) {
    return [subPath.replace(/\\/g, '/')];
  }
  if (!stat.isDirectory()) return [];
  const entries = readdirSync(fullPath).sort();
  return entries.flatMap(entry =>
    collectFilesRecursively(baseDir, subPath ? join(subPath, entry) : entry)
  );
}

export function collectPluginFileManifest(sourceRoot) {
  const resolvedSource = resolve(sourceRoot);
  const manifestPath = join(resolvedSource, 'plugin.json');
  assert.ok(existsSync(manifestPath), `Missing plugin.json in ${resolvedSource}`);
  const parsedPlugin = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(parsedPlugin.name, PLUGIN_ID, `Unexpected plugin name: ${parsedPlugin.name}`);

  const relativeFiles = [];
  for (const topEntry of PACKAGE_INCLUDED_PATHS) {
    const candidate = join(resolvedSource, topEntry);
    if (existsSync(candidate)) {
      relativeFiles.push(...collectFilesRecursively(resolvedSource, topEntry));
    }
  }

  return relativeFiles.map(relPath => {
    const absPath = join(resolvedSource, relPath);
    const bytes = readFileSync(absPath);
    return {
      path: relPath,
      size: bytes.length,
      sha256: sha256Buffer(bytes)
    };
  });
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

export async function installPluginPackage({
  sourceRoot,
  home = homedir(),
  env = process.env,
  startSidecarIfNeeded = true
}) {
  const resolvedSource = resolve(sourceRoot);
  const paths = resolveInstallationPaths({ home, env });
  assertPathInsideRoot(paths.geminiRoot, paths.installedPluginDir);

  if (existsSync(paths.installedPluginDir)) {
    const existingManifestPath = join(paths.installedPluginDir, 'plugin.json');
    if (existsSync(existingManifestPath)) {
      const existingManifest = JSON.parse(readFileSync(existingManifestPath, 'utf8'));
      if (existingManifest.name && existingManifest.name !== PLUGIN_ID) {
        throw new Error(`Destination contains a different plugin: ${existingManifest.name}`);
      }
    }
  }

  const files = collectPluginFileManifest(resolvedSource);

  // Stop any older running sidecar instance cleanly before replacing files
  await stopExistingRuntimes(paths.runtimeDir, { purge: false });

  mkdirSync(paths.installedPluginDir, { recursive: true });
  for (const item of files) {
    const srcFile = join(resolvedSource, item.path);
    const dstFile = join(paths.installedPluginDir, item.path);
    mkdirSync(dirname(dstFile), { recursive: true });
    cpSync(srcFile, dstFile, { force: true });
  }

  // Verify every copied file's SHA-256
  for (const item of files) {
    const dstFile = join(paths.installedPluginDir, item.path);
    const actualHash = sha256Buffer(readFileSync(dstFile));
    if (actualHash !== item.sha256) {
      throw new Error(`SHA-256 verification failed for ${item.path}`);
    }
  }

  const receipt = {
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    installedAt: new Date().toISOString(),
    sourceRoot: resolvedSource,
    fileCount: files.length,
    files
  };
  writeJsonAtomically(join(paths.installedPluginDir, '.install-receipt.json'), receipt);

  let activeRuntime = null;
  if (startSidecarIfNeeded) {
    // Wait briefly to see if Antigravity's native sidecar watcher spawns it automatically
    for (let i = 0; i < 6; i++) {
      activeRuntime = await findActiveRuntime(paths.runtimeDir);
      if (activeRuntime) break;
      await delay(300);
    }
    if (!activeRuntime) {
      const sidecarMain = join(paths.installedPluginDir, 'sidecars', 'translator', 'main.mjs');
      const child = spawn(process.execPath, [sidecarMain], {
        cwd: dirname(sidecarMain),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...env }
      });
      child.unref();

      for (let i = 0; i < 16; i++) {
        await delay(300);
        activeRuntime = await findActiveRuntime(paths.runtimeDir);
        if (activeRuntime?.health?.healthy || i >= 8 && activeRuntime) break;
      }
    }
  }

  return {
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    destination: paths.installedPluginDir,
    fileCount: files.length,
    runtimeStarted: Boolean(activeRuntime),
    uiHealthy: Boolean(activeRuntime?.health?.healthy),
    attachedWindows: activeRuntime?.health?.attachedWindows || 0
  };
}

export async function uninstallPluginPackage({
  home = homedir(),
  env = process.env,
  keepSettings = false
} = {}) {
  const paths = resolveInstallationPaths({ home, env });
  assertPathInsideRoot(paths.geminiRoot, paths.installedPluginDir);

  await stopExistingRuntimes(paths.runtimeDir, { purge: !keepSettings });

  if (existsSync(paths.installedPluginDir)) {
    rmSync(paths.installedPluginDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
  if (!keepSettings && existsSync(paths.pluginDataDir)) {
    rmSync(paths.pluginDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
  if (!keepSettings && existsSync(paths.sidecarDataDir)) {
    rmSync(paths.sidecarDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }

  return {
    removed: true,
    keepSettings,
    destination: paths.installedPluginDir
  };
}

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as glob from '@actions/glob'
import * as io from '@actions/io'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as semver from 'semver'
import * as util from 'util'
import {
  CacheFilename,
  CacheFormat,
  CompressionMethod,
  GnuTarPathOnWindows
} from './constants.js'

const versionSalt = '1.0'

export function getWorkingDirectory(): string {
  return process.env['GITHUB_WORKSPACE'] ?? process.cwd()
}

// From https://github.com/actions/toolkit/blob/main/packages/tool-cache/src/tool-cache.ts#L23
export async function createTempDirectory(): Promise<string> {
  const IS_WINDOWS = process.platform === 'win32'

  let tempDirectory: string = process.env['RUNNER_TEMP'] || ''

  if (!tempDirectory) {
    let baseLocation: string
    if (IS_WINDOWS) {
      // On Windows use the USERPROFILE env variable
      baseLocation = process.env['USERPROFILE'] || 'C:\\'
    } else {
      if (process.platform === 'darwin') {
        baseLocation = '/Users'
      } else {
        baseLocation = '/home'
      }
    }
    tempDirectory = path.join(baseLocation, 'actions', 'temp')
  }

  const dest = path.join(tempDirectory, crypto.randomUUID())
  await io.mkdirP(dest)
  return dest
}

export function getArchiveFileSizeInBytes(filePath: string): number {
  return fs.statSync(filePath).size
}

export async function resolvePaths(patterns: string[]): Promise<string[]> {
  const paths: string[] = []
  const workspace = getWorkingDirectory()
  const globber = await glob.create(patterns.join('\n'), {
    implicitDescendants: false
  })

  for await (const file of globber.globGenerator()) {
    const relativeFile = path
      .relative(workspace, file)
      .replace(new RegExp(`\\${path.sep}`, 'g'), '/')
    core.debug(`Matched: ${relativeFile}`)
    // Paths are made relative so the tar entries are all relative to the root of the workspace.
    if (relativeFile === '') {
      // path.relative returns empty string if workspace and file are equal
      paths.push('.')
    } else {
      paths.push(`${relativeFile}`)
    }
  }

  return paths
}

export async function unlinkFile(filePath: fs.PathLike): Promise<void> {
  return util.promisify(fs.unlink)(filePath)
}

async function getVersion(
  app: string,
  additionalArgs: string[] = []
): Promise<string> {
  let versionOutput = ''
  additionalArgs.push('--version')
  core.debug(`Checking ${app} ${additionalArgs.join(' ')}`)
  try {
    await exec.exec(`${app}`, additionalArgs, {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer): string => (versionOutput += data.toString()),
        stderr: (data: Buffer): string => (versionOutput += data.toString())
      }
    })
  } catch (err) {
    core.debug(err.message)
  }

  versionOutput = versionOutput.trim()
  core.debug(versionOutput)
  return versionOutput
}

// Use zstandard if possible to maximize cache performance
export async function getCompressionMethod(format?: CacheFormat): Promise<CompressionMethod> {
  switch(format) {
    case CacheFormat.SquashFS:
    case CacheFormat.EROFS:
      return CompressionMethod.Gzip

    default:
      const versionOutput = await getVersion('zstd', ['--quiet'])
      const version = semver.clean(versionOutput)
      core.debug(`zstd version: ${version}`)

      if (versionOutput === '') {
        return CompressionMethod.Gzip
      } else {
        return CompressionMethod.ZstdWithoutLong
      }
  }
}

export function getCacheFileName(compressionMethod: CompressionMethod): string {
  return compressionMethod === CompressionMethod.Gzip
    ? CacheFilename.Gzip
    : CacheFilename.Zstd
}

export async function getGnuTarPathOnWindows(): Promise<string> {
  if (fs.existsSync(GnuTarPathOnWindows)) {
    return GnuTarPathOnWindows
  }
  const versionOutput = await getVersion('tar')
  return versionOutput.toLowerCase().includes('gnu tar') ? io.which('tar') : ''
}

export function assertDefined<T>(name: string, value?: T): T {
  if (value === undefined) {
    throw Error(`Expected ${name} but value was undefiend`)
  }

  return value
}

export function getCacheVersion(
  paths: string[],
  format: CacheFormat,
  compressionMethod?: CompressionMethod,
  enableCrossOsArchive = false
): string {
  // don't pass changes upstream
  const components = paths.slice()

  if (format != CacheFormat.Default) {
    components.push(format)
  }

  // Add compression method to cache version to restore
  // compressed cache as per compression method
  if (compressionMethod) {
    components.push(compressionMethod)
  }

  // Only check for windows platforms if enableCrossOsArchive is false
  if (process.platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only')
  }

  // Add salt to cache version to support breaking changes in cache entry
  components.push(versionSalt)

  return crypto.createHash('sha256').update(components.join('|')).digest('hex')
}

export function getRuntimeToken(): string {
  const token = process.env['ACTIONS_RUNTIME_TOKEN']
  if (!token) {
    throw new Error('Unable to get the ACTIONS_RUNTIME_TOKEN env variable')
  }
  return token
}

function changeExtension(filePath: string, newExt: string): string {
  const ext = newExt.startsWith(".") ? newExt : `.${newExt}`
  const { dir, name } = path.parse(filePath)
  return path.join(dir, `${name}${ext}`)
}

export async function tar2SquashFS(archivePath: string): Promise<string> {
  const imagePath = changeExtension(archivePath, CacheFormat.SquashFS)
  // We might consider using lz4 for the parity with EROFS
  await exec.exec(`sh -c "zcat ${archivePath} | sqfstar -comp zstd -b 1M ${imagePath}"`)
  return imagePath
}

export async function tar2EROFS(archivePath: string): Promise<string> {
  const imagePath = changeExtension(archivePath, CacheFormat.EROFS)
  // Ubuntu24 images have mkfs.erofs compiled without zstd support hence lz4 
  await exec.exec(`mkfs.erofs -z lz4 --tar=f --gzip ${imagePath} ${archivePath}`)
  return imagePath
}

export async function mountImage(archivePath: string, format: CacheFormat) : Promise<void> {
  const parentDir = await createTempDirectory()
  // Workspace dir is bind mounted here
  const localDir = path.join(parentDir, "local")
  // Cache is mounted here
  const cacheDir = path.join(parentDir, "cache")
  // Writable dir for the overlay upper layer
  const writeDir = path.join(parentDir, "write")
  // Work directory for the OverlayFS
  const workDir = path.join(parentDir, "work")
  // Merged OverlayFS directory
  const mergeDir = path.join(parentDir, "merge")

  await io.mkdirP(localDir)
  await io.mkdirP(cacheDir)
  await io.mkdirP(writeDir)
  await io.mkdirP(workDir)
  await io.mkdirP(mergeDir)

  const workspaceDir = getWorkingDirectory()

  core.debug(`Mounting workspace to ${localDir}`)
  await exec.exec(`sudo mount --bind ${workspaceDir} ${localDir}`)
  await exec.exec(`sudo mount -o remount,bind,ro ${localDir}`)

  core.debug(`Mounting cache to ${cacheDir}`)
  await exec.exec(`sudo mount -t ${format} -o loop,ro ${archivePath} ${cacheDir}`)

  core.debug(`Mounting OverlayFS to ${mergeDir}`)
  await exec.exec(`sudo mount -t overlay overlay -o lowerdir="${cacheDir}:${localDir}",upperdir=${writeDir},workdir=${workDir} ${mergeDir}`)

  core.debug(`Mounting ${mergeDir} on top of workspace`)
  await exec.exec(`sudo mount --bind ${mergeDir} "${workspaceDir}`)
}

export async function listImage(archivePath: string, format: CacheFormat) : Promise<void> {
  switch(format) {
    case CacheFormat.SquashFS:
      await exec.exec(`unsquashfs -l ${archivePath}`)
      break

    case CacheFormat.EROFS:
      // This is not a recursive print
      await exec.exec(`dump.erofs --ls --path=/ ${archivePath}`)
      break

    default:
      throw Error(`Unexpected format ${format}`)
  }
}

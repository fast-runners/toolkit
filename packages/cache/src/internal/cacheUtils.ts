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
import {
  DataLakeServiceClient,
  generateDataLakeSASQueryParameters,
  FileSystemSASPermissions,
  SASProtocol
} from "@azure/storage-file-datalake";
import YAML from 'yaml';
import { ClientAssertionCredential } from '@azure/identity'

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

export function getBlockSize(): string {
  const value = process.env['CACHE_BLOCK_SIZE']
  if (!value) {
    return '131072' // 128Kb
  }
  return value
}

export function getFuseBlockSize(): string {
  const value = process.env['FUSE_BLOCK_SIZE']
  if (!value) {
    return '16' // 16Mb
  }
  return value
}

export function getCompression(): string {
  const value = process.env['SQUASHFS_COMP']
  if (!value) {
    return 'zstd'
  }
  return value
}

export function getDisableFileCache(): boolean {
  const value = process.env['FUSE_NO_FILE_CACHE']
  if (value) {
    return true
  }
  return false
}


export async function tar2SquashFS(archivePath: string): Promise<string> {
  const imagePath = changeExtension(archivePath, CacheFormat.SquashFS)
  const blockSize = getBlockSize()
  const comp = getCompression()
  await exec.exec(`sh -c "zcat ${archivePath} | sqfstar -comp ${comp} -b ${blockSize} ${imagePath}"`)
  return imagePath
}

export async function tar2EROFS(archivePath: string): Promise<string> {
  const imagePath = changeExtension(archivePath, CacheFormat.EROFS)
  const blockSize = getBlockSize()
  // Ubuntu24 images have mkfs.erofs compiled without zstd support hence lzma
  await exec.exec(`mkfs.erofs -z lz4hc -C ${blockSize} --tar=f --gzip ${imagePath} ${archivePath}`)
  return imagePath
}

export async function mountImage(archiveName: string, format: CacheFormat, blobfuseConfig: string) : Promise<string> {
  const parentDir = await createTempDirectory()

  // Workspace dir is bind mounted here
  const localDir = path.join(parentDir, "local")
  // Blobfuse2 mount point
  const fuseDir = path.join(parentDir, "fuse")
  // Blobfuse2 file cache
  const tmpDir = path.join(parentDir, "block")
  // Cache is mounted here
  const cacheDir = path.join(parentDir, "cache")
  // Writable dir for the overlay upper layer
  const writeDir = path.join(parentDir, "write")
  // Work directory for the OverlayFS
  const workDir = path.join(parentDir, "work")
  // Merged OverlayFS directory
  const mergeDir = path.join(parentDir, "merge")

  await io.mkdirP(localDir)
  await io.mkdirP(fuseDir)
  await io.mkdirP(tmpDir)
  await io.mkdirP(cacheDir)
  await io.mkdirP(writeDir)
  await io.mkdirP(workDir)
  await io.mkdirP(mergeDir)

  const workspaceDir = getWorkingDirectory()

  core.debug(`Mounting blobfuse to ${fuseDir}`)
  const configFile = path.join(parentDir, 'config.yml')
  fs.writeFileSync(configFile, blobfuseConfig);
  let fileCache = `--block-cache-path ${tmpDir}`
  if (getDisableFileCache()) {
    fileCache = ''
  }
  await exec.exec(`sudo blobfuse2 mount ${fuseDir} --read-only --block-cache ${fileCache} --config-file ${configFile} --streaming`)

  core.debug(`Mounting workspace to ${localDir}`)
  await exec.exec(`sudo mount --bind ${workspaceDir} ${localDir}`)
  await exec.exec(`sudo mount -o remount,bind,ro ${localDir}`)

  core.debug(`Mounting cache to ${cacheDir}`)
  const archivePath = path.join(fuseDir, archiveName)
  // threads=multu is a SquashFS option
  await exec.exec(`sudo mount -t ${format} -o loop,ro,threads=multi ${archivePath} ${cacheDir}`)

  core.debug(`Mounting OverlayFS to ${mergeDir}`)
  await exec.exec(`sudo mount -t overlay overlay -o lowerdir="${cacheDir}:${localDir}",upperdir=${writeDir},workdir=${workDir},volatile ${mergeDir}`)

  core.debug(`Mounting ${mergeDir} on top of workspace`)
  await exec.exec(`sudo mount --bind ${mergeDir} "${workspaceDir}`)

  return cacheDir
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

interface BlobUrlParts {
  accountName: string;
  containerName: string;
  blobDir: string;
  sasToken: string;
}

function parseBlobUrlWithSas(url: string): BlobUrlParts {
  const urlObj = new URL(url);
  
  const accountName = urlObj.hostname.split('.')[0];
  const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
  const containerName = pathParts[0] || '';
  const blobDir = pathParts.slice(1, -1).join('/');
  const sasToken = urlObj.search;
  
  return {
    accountName,
    containerName,
    blobDir,
    sasToken
  };
}

function getLogLevel(): string {
  const value = process.env['FUSE_LOG_LEVEL']
  if (!value) {
    return 'log_info'
  }
  return value
}

export async function generateBlobfuse2Config(blobUrl: string): Promise<string> {
  const { accountName, containerName, blobDir, sasToken } = await getBlobMountParts(blobUrl);
  const blockSize = getFuseBlockSize()
  const logLevel = getLogLevel()
    
  const config = {
    logging: {
      'type' : 'base',
      'level': `${logLevel}`  
    },
    block_cache: {
      'block-size-mb': blockSize,
      'prefetch-on-open': true,
      'disk-timeout-sec': 21600
    },
    attr_cache: {
      'timeout-sec': 21600
    },
    azstorage: {
      'type': 'adls',
      'account-name': accountName,
      'container': containerName,
      'mode': 'sas',
      'subdirectory': blobDir,
      'sas': sasToken
    }
  };
  
  return YAML.stringify(config);
}

export async function generateDataLakeSas(
  accountName: string,
  containerName: string,
  directoryPath?: string,
): Promise<string> {
  const clientId: string = process.env.SPN_CLIENT_ID ?? '';
  const tenantId: string = process.env.SPN_TENANT_ID ?? '';
  const credential = new ClientAssertionCredential(
    tenantId,
    clientId,
    async () => await core.getIDToken('api://AzureADTokenExchange')
  );

  const datalakeServiceClient = new DataLakeServiceClient(
    `https://${accountName}.dfs.core.windows.net`,
    credential
  );
  
  // Get user delegation key
  const startsOn = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago to account for clock skew
  const expiresOn = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 hours from now
  
  const userDelegationKey = await datalakeServiceClient.getUserDelegationKey(
    startsOn,
    expiresOn
  );
  
  const sasQueryParameters = generateDataLakeSASQueryParameters(
    {
      fileSystemName: containerName,
      pathName: directoryPath,
      isDirectory: true,
      permissions: FileSystemSASPermissions.parse("rl"),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https
    },
    userDelegationKey,
    accountName
  ).toString();
  
  return sasQueryParameters.toString();
}

async function getAzureVmLocation(): Promise<string | undefined> {
  try {
    // Query Azure Instance Metadata Service (IMDS) to get VM compute metadata
    const response = await fetch('http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01', {
      headers: {
        'Metadata': 'true'
      },
    });
    
    if (response.ok) {
      const computeData = await response.json();
      const location = computeData.location;
      core.debug(`Azure VM location detected: ${location}`);
      return location.toLowerCase();
    }
  } catch (error) {
    core.debug(`Failed to query Azure IMDS: ${error}`);
  }
  return undefined;
}

async function getBlobMountParts(
  originalUrl: string,
): Promise<BlobUrlParts> {
  const vmLocation = await getAzureVmLocation();
  if (!vmLocation) {
    throw new Error('VM location not detected');
  }

  // Find storage account that ends with VM location (pick shortest prefix after stripping location suffix)
  // This is to handle cases where we have foocentralus, foonorthcentralus and foosouthcentralus
  const additionalStorageAccounts = process.env.ADDITIONAL_STORAGE_ACCOUNTS ?? '';
  let selectedStorageAccount: string | undefined;
  let shortestPrefixLength = Infinity;
  
  const storageAccountNames: string[] = additionalStorageAccounts.split(',');
  for (const storageAccount of storageAccountNames) {
    if (storageAccount.endsWith(vmLocation)) {
      const prefix = storageAccount.slice(0, -vmLocation.length);
      if (prefix.length < shortestPrefixLength) {
        shortestPrefixLength = prefix.length;
        selectedStorageAccount = storageAccount;
      }
    }
  }

  if (!selectedStorageAccount) {
    throw new Error(`No storage account found in ${vmLocation}`);
  }

  core.debug(`Using storage account: ${selectedStorageAccount}`);

  // Extract blob name from original URL
  const urlPath = new URL(originalUrl).pathname;
  const fileName = urlPath.split('/').pop() ?? '';
  const sas = await generateDataLakeSas(
    selectedStorageAccount,
    'actions-cache',
    fileName
  )

  return {
    accountName: selectedStorageAccount,
    containerName: 'actions-cache',
    blobDir: fileName,
    sasToken: sas
  };
}

import { app } from 'electron'
import packageMetadata from '../../package.json'
import type { IssueReportEnvironment } from '../shared/issue-report'

export function issueReportEnvironment(): IssueReportEnvironment {
  return {
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    architecture: process.arch,
    appVersion: app.getVersion(),
    // Embedded at compile time: electron-builder may strip build config from package.json.
    appBuild: packageMetadata.build.buildVersion
  }
}

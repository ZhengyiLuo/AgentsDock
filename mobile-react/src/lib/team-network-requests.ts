type TeamNetworkOperation = 'workspace' | 'mail' | 'detail' | 'post' | 'agent'

export interface TeamNetworkRequest {
  operation: TeamNetworkOperation
  revision: number
  workspaceRevision: number
}

/** Keeps unrelated controls independent while invalidating every old-team result together. */
export class TeamNetworkRequests {
  private workspaceRevision = 0
  private revisions = new Map<TeamNetworkOperation, number>()

  begin(operation: TeamNetworkOperation): TeamNetworkRequest {
    this.cancel(operation)
    return { operation, revision: this.revisions.get(operation)!, workspaceRevision: this.workspaceRevision }
  }

  isCurrent(request: TeamNetworkRequest): boolean {
    return request.workspaceRevision === this.workspaceRevision
      && request.revision === this.revisions.get(request.operation)
  }

  cancel(operation: TeamNetworkOperation): void {
    this.revisions.set(operation, (this.revisions.get(operation) ?? 0) + 1)
  }

  reset(): void {
    this.workspaceRevision += 1
    this.revisions.clear()
  }
}

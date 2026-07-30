/**
 * Policy documents: per-principal allowed scopes, stored in DynamoDB.
 * Deny-by-default — a missing record means no token, ever.
 */

import { isValidScope } from '@platform/authorizer'
import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb'
import { z } from 'zod'
import { TokenServiceError } from './errors'

/** Minimal structural view of DynamoDBDocumentClient (injectable for tests). */
export interface PolicyStoreClient {
  send(command: GetCommand): Promise<GetCommandOutput>
}

const policyDocumentSchema = z
  .object({
    principalId: z.string().min(1),
    allowedScopes: z.array(z.string().refine(isValidScope, 'must be a valid scope'))
  })
  .passthrough()

export interface PolicyDocument {
  readonly principalId: string
  readonly allowedScopes: readonly string[]
}

export interface PolicyRepository {
  /** Returns the principal's policy, or null when none exists (deny). */
  findByPrincipalId(principalId: string): Promise<PolicyDocument | null>
}

export class DynamoDbPolicyRepository implements PolicyRepository {
  private readonly client: PolicyStoreClient
  private readonly tableName: string

  constructor(client: PolicyStoreClient, tableName: string) {
    this.client = client
    this.tableName = tableName
  }

  async findByPrincipalId(principalId: string): Promise<PolicyDocument | null> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { principalId },
        ConsistentRead: true
      })
    )

    if (output.Item === undefined) {
      return null
    }

    const parsed = policyDocumentSchema.safeParse(output.Item)

    if (!parsed.success) {
      // Fail closed: a corrupt policy must deny, never allow.
      throw new TokenServiceError(
        'POLICY_INVALID',
        403,
        `Policy document for principal "${principalId}" is malformed`,
        'Fix the policy record in the policies table (fields: principalId, allowedScopes[]) before requesting tokens.'
      )
    }

    return {
      principalId: parsed.data.principalId,
      allowedScopes: Object.freeze([...parsed.data.allowedScopes])
    }
  }
}

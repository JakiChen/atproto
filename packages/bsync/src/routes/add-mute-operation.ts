import { sql } from 'kysely'
import {
  AtUri,
  InvalidDidError,
  ensureValidAtUri,
  ensureValidDid,
} from '@atproto/syntax'
import { Code, ConnectError, ServiceImpl } from '@connectrpc/connect'
import { Service } from '../gen/bsync_connect'
import { AddMuteOperationResponse, MuteOperation_Type } from '../gen/bsync_pb'
import AppContext from '../context'
import { createMuteOpChannel } from '../db/schema/mute_op'
import { authWithApiKey } from './auth'
import Database from '../db'

export default (ctx: AppContext): Partial<ServiceImpl<typeof Service>> => ({
  async addMuteOperation(req, handlerCtx) {
    authWithApiKey(ctx, handlerCtx)
    const { db } = ctx
    const op = validMuteOp(req)
    const id = await db.transaction(async (txn) => {
      // create mute op
      const id = await createMuteOp(txn, op)
      // update mute state
      if (op.type === MuteOperation_Type.ADD) {
        await addMuteItem(txn, id, op)
      } else if (op.type === MuteOperation_Type.REMOVE) {
        await removeMuteItem(txn, op)
      } else if (op.type === MuteOperation_Type.CLEAR) {
        await clearMuteItems(txn, op)
      } else {
        const exhaustiveCheck: never = op.type
        throw new Error(`unreachable: ${exhaustiveCheck}`)
      }
      return id
    })
    return new AddMuteOperationResponse({
      operation: {
        id: String(id),
        type: op.type,
        actorDid: op.actorDid,
        subject: op.subject,
      },
    })
  },
})

const createMuteOp = async (db: Database, op: MuteOpInfo) => {
  const { ref } = db.db.dynamic
  const { id } = await db.db
    .insertInto('mute_op')
    .values({
      type: op.type,
      actorDid: op.actorDid,
      subject: op.subject,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await sql`notify ${ref(createMuteOpChannel)}`.execute(db.db) // emitted transactionally
  return id
}

const addMuteItem = async (db: Database, fromId: number, op: MuteOpInfo) => {
  const { ref } = db.db.dynamic
  await db.db
    .insertInto('mute_item')
    .values({
      actorDid: op.actorDid,
      subject: op.subject,
      fromId,
    })
    .onConflict((oc) =>
      oc
        .constraint('mute_item_pkey')
        .doUpdateSet({ fromId: sql`${ref('excluded.fromId')}` }),
    )
    .execute()
}

const removeMuteItem = async (db: Database, op: MuteOpInfo) => {
  await db.db
    .deleteFrom('mute_item')
    .where('actorDid', '=', op.actorDid)
    .where('subject', '=', op.subject)
    .execute()
}

const clearMuteItems = async (db: Database, op: MuteOpInfo) => {
  await db.db
    .deleteFrom('mute_item')
    .where('actorDid', '=', op.actorDid)
    .execute()
}

const validMuteOp = (op: MuteOpInfo): MuteOpInfo => {
  if (!Object.values(MuteOperation_Type).includes(op.type)) {
    throw new ConnectError('bad mute operation type', Code.InvalidArgument)
  }
  if (!isValidDid(op.actorDid)) {
    throw new ConnectError(
      'actor_did must be a valid did',
      Code.InvalidArgument,
    )
  }
  if (op.type === MuteOperation_Type.CLEAR) {
    if (op.subject !== '') {
      throw new ConnectError(
        'subject must not be set on a clear op',
        Code.InvalidArgument,
      )
    }
  } else {
    if (isValidDid(op.subject)) {
      // all good
    } else if (isValidAtUri(op.subject)) {
      const uri = new AtUri(op.subject)
      if (uri.collection !== 'app.bsky.graph.list') {
        throw new ConnectError(
          'subject aturis must reference a list record',
          Code.InvalidArgument,
        )
      }
    } else {
      throw new ConnectError(
        'subject must be a did or aturi on add or remove op',
        Code.InvalidArgument,
      )
    }
  }
  return op
}

const isValidDid = (did: string) => {
  try {
    ensureValidDid(did)
    return true
  } catch (err) {
    if (err instanceof InvalidDidError) {
      return false
    }
    throw err
  }
}

const isValidAtUri = (uri: string) => {
  try {
    ensureValidAtUri(uri)
    return true
  } catch {
    return false
  }
}

type MuteOpInfo = {
  type: MuteOperation_Type
  actorDid: string
  subject: string
}

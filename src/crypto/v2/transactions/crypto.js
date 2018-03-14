import Config from '@/config'
import crypto from 'crypto'
import cryptoUtils from '@/crypto/crypto'
import ECPair from '@/crypto/ecpair'
import ECSignature from '@/crypto/ecsignature'
import bs58check from 'bs58check'
import ByteBuffer from 'bytebuffer'
import {
  ARKTOSHI,
  TRANSACTION_TYPES
} from '@/constants'

if (typeof Buffer === 'undefined') Buffer = require('buffer/').Buffer // eslint-disable-line no-global-assign

export default class Crypto {
  getBytes (transaction) {
    const bb = new ByteBuffer(512, true)
    bb.writeByte(0xff) // fill, to disambiguate from v1
    bb.writeByte(transaction.version) // version 2
    bb.writeByte(transaction.network) // ark = 0x17, devnet = 0x30
    bb.writeByte(transaction.type)
    bb.writeInt(transaction.timestamp)
    bb.append(transaction.senderPublicKey, 'hex')
    bb.writeLong(transaction.fee)
    if (transaction.vendorFieldHex) {
      bb.writeByte(transaction.vendorFieldHex.length / 2)
      bb.append(transaction.vendorFieldHex, 'hex')
    } else {
      bb.writeByte(0x00)
    }

    const actions = {
      [TRANSACTION_TYPES.TRANSFER]: () => {
        bb.writeLong(transaction.amount)
        bb.writeInt(transaction.expiration)
        bb.append(bs58check.decode(transaction.recipientId))
      },
      [TRANSACTION_TYPES.SECOND_SIGNATURE]: () => {
        bb.append(transaction.asset.signature.publicKey, 'hex')
      },
      [TRANSACTION_TYPES.DELEGATE]: () => {
        const delegateBytes = Buffer.from(transaction.asset.delegate.username, 'utf8')
        bb.writeByte(delegateBytes.length / 2)
        bb.append(delegateBytes, 'hex')
      },
      [TRANSACTION_TYPES.VOTE]: () => {
        const voteBytes = transaction.asset.votes.map(function (vote) {
          return (vote[0] === '+' ? '01' : '00') + vote.slice(1)
        }).join('')
        bb.writeByte(transaction.asset.votes.length)
        bb.append(voteBytes, 'hex')
      },
      [TRANSACTION_TYPES.MULTI_SIGNATURE]: () => {
        const keysgroupBuffer = Buffer.from(transaction.asset.multisignature.keysgroup.join(''), 'hex')
        bb.writeByte(transaction.asset.multisignature.min)
        bb.writeByte(transaction.asset.multisignature.keysgroup.length)
        bb.writeByte(transaction.asset.multisignature.lifetime)
        bb.append(keysgroupBuffer, 'hex')
      },
      [TRANSACTION_TYPES.IPFS]: () => {
        bb.writeByte(transaction.asset.ipfs.dag.length / 2)
        bb.append(transaction.asset.ipfs.dag, 'hex')
      },
      [TRANSACTION_TYPES.TIMELOCK_TRANSFER]: () => {
        bb.writeLong(transaction.amount)
        bb.writeByte(transaction.timelocktype)
        bb.writeInt(transaction.timelock)
        bb.append(bs58check.decode(transaction.recipientId))
      },
      [TRANSACTION_TYPES.MULTI_PAYMENT]: () => {
        bb.writeInt(transaction.asset.payments.length)
        transaction.asset.payments.forEach(function (p) {
          bb.writeLong(p.amount)
          bb.append(bs58check.decode(p.recipientId))
        })
      },
      [TRANSACTION_TYPES.DELEGATE_RESIGNATION]: () => {}
    }

    actions[transaction.type]()

    bb.flip()
    return bb.toBuffer()
  }

  fromBytes (hexString) {
    let tx = {}
    const buf = Buffer.from(hexString, 'hex')
    tx.version = buf.readInt8(1) & 0xff
    tx.network = buf.readInt8(2) & 0xff
    tx.type = buf.readInt8(3) & 0xff
    tx.timestamp = buf.readUInt32LE(4)
    tx.senderPublicKey = hexString.substring(16, 16 + 33 * 2)
    tx.fee = buf.readUInt32LE(41)
    const vflength = buf.readInt8(41 + 8) & 0xff
    if (vflength > 0) {
      tx.vendorFieldHex = hexString.substring((41 + 8 + 1) * 2, (41 + 8 + 1) * 2 + vflength * 2)
    }

    const assetOffset = (41 + 8 + 1) * 2 + vflength * 2

    if (tx.type === 0) { // transfer
      tx.amount = buf.readUInt32LE(assetOffset / 2)
      tx.expiration = buf.readUInt32LE(assetOffset / 2 + 8)
      tx.recipientId = bs58check.encode(buf.slice(assetOffset / 2 + 12, assetOffset / 2 + 12 + 21))
      this.parseSignatures(hexString, tx, assetOffset + (21 + 12) * 2)
    } else if (tx.type === 1) { // second signature registration
      tx.asset = {
        signature: {
          publicKey: hexString.substring(assetOffset, assetOffset + 66)
        }
      }
      this.parseSignatures(hexString, tx, assetOffset + 66)
    } else if (tx.type === 2) { // delegate registration
      const usernamelength = buf.readInt8(assetOffset / 2) & 0xff

      tx.asset = {
        delegate: {
          username: buf.slice(assetOffset / 2 + 1, assetOffset / 2 + 1 + usernamelength).toString('utf8')
        }
      }
      this.parseSignatures(hexString, tx, assetOffset + (usernamelength + 1) * 2)
    } else if (tx.type === 3) { // vote
      const votelength = buf.readInt8(assetOffset / 2) & 0xff
      tx.asset = {
        votes: []
      }
      let vote
      for (let i = 0; i < votelength; i++) {
        vote = hexString.substring(assetOffset + 2 + i * 2 * 34, assetOffset + 2 + (i + 1) * 2 * 34)
        vote = (vote[1] === '1' ? '+' : '-') + vote.slice(2)
        tx.asset.votes.push(vote)
      }
      this.parseSignatures(hexString, tx, assetOffset + 2 + votelength * 34 * 2)
    } else if (tx.type === 4) { // multisignature creation
      tx.asset = {
        multisignature: {}
      }
      tx.asset.multisignature.min = buf.readInt8(assetOffset / 2) & 0xff
      const num = buf.readInt8(assetOffset / 2 + 1) & 0xff
      tx.asset.multisignature.lifetime = buf.readInt8(assetOffset / 2 + 2) & 0xff
      tx.asset.multisignature.keysgroup = []
      for (let index = 0; index < num; index++) {
        let key = hexString.slice(assetOffset + 6 + index * 66, assetOffset + 6 + (index + 1) * 66) // eslint-disable-line no-unused-vars
      }
      this.parseSignatures(hexString, tx, assetOffset + 6 + num * 66)
    } else if (tx.type === 5) { // ipfs
      tx.asset = {}
      const l = buf.readInt8(assetOffset / 2) & 0xff
      tx.asset.dag = hexString.substring(assetOffset + 2, assetOffset + 2 + l * 2)
      this.parseSignatures(hexString, tx, assetOffset + 2 + l * 2)
    } else if (tx.type === 6) { // timelock
      tx.amount = buf.readUInt32LE(assetOffset / 2)
      tx.timelocktype = buf.readInt8(assetOffset / 2 + 8) & 0xff
      tx.timelock = buf.readUInt32LE(assetOffset / 2 + 9)
      tx.recipientId = bs58check.encode(buf.slice(assetOffset / 2 + 13, assetOffset / 2 + 13 + 21))
      this.parseSignatures(hexString, tx, assetOffset + (21 + 13) * 2)
    } else if (tx.type === 7) { // multipayment
      tx.asset = {
        payments: []
      }
      const total = buf.readInt8(assetOffset / 2) & 0xff
      let offset = assetOffset / 2 + 1
      for (let i = 0; i < total; i++) {
        let payment = {}
        payment.amount = buf.readUInt32LE(offset)
        payment.recipientId = bs58check.encode(buf.slice(offset + 1, offset + 1 + 21))
        tx.asset.payments.push(payment)
        offset += 22
      }
      this.parseSignatures(hexString, tx, offset * 2)
    } else if (tx.type === 8) { // delegate resignation
      this.parseSignatures(hexString, tx, assetOffset)
    }
    return tx
  }

  parseSignatures (hexString, tx, startOffset) {
    tx.signature = hexString.substring(startOffset)
    if (tx.signature.length === 0) delete tx.signature
    else {
      const length = parseInt('0x' + tx.signature.substring(2, 4), 16) + 2
      tx.signature = hexString.substring(startOffset, startOffset + length * 2)
      tx.secondSignature = hexString.substring(startOffset + length * 2)
      if (tx.secondSignature.length === 0) delete tx.secondSignature
    }
  }

  getId (transaction) {
    return this.getHash(transaction).toString('hex')
  }

  getHash (transaction) {
    return crypto.createHash('sha256').update(this.getBytes(transaction)).digest()
  }

  getFee (transaction) {
    return {
      [TRANSACTION_TYPES.TRANSFER]: () => 0.1 * ARKTOSHI,
      [TRANSACTION_TYPES.SECOND_SIGNATURE]: () => 100 * ARKTOSHI,
      [TRANSACTION_TYPES.DELEGATE]: () => 10000 * ARKTOSHI,
      [TRANSACTION_TYPES.VOTE]: () => 1 * ARKTOSHI,
      [TRANSACTION_TYPES.MULTI_SIGNATURE]: () => 0,
      [TRANSACTION_TYPES.IPFS]: () => 0,
      [TRANSACTION_TYPES.TIMELOCK_TRANSFER]: () => 0,
      [TRANSACTION_TYPES.MULTI_PAYMENT]: () => 0,
      [TRANSACTION_TYPES.DELEGATE_RESIGNATION]: () => 0
    }[transaction.type]
  }

  sign (transaction, keys) {
    const hash = this.getHash(transaction)
    const signature = keys.sign(hash).toDER().toString('hex')

    if (!transaction.signature) {
      transaction.signature = signature
    }

    return signature
  }

  secondSign (transaction, keys) {
    const hash = this.getHash(transaction)
    const signature = keys.sign(hash).toDER().toString('hex')

    if (!transaction.secondSignature) {
      transaction.secondSignature = signature
    }

    return signature
  }

  verify (transaction, network) {
    const hash = this.getHash(transaction)

    const signatureBuffer = Buffer.from(transaction.signature, 'hex')
    const senderPublicKeyBuffer = Buffer.from(transaction.senderPublicKey, 'hex')
    const ecpair = ECPair.fromPublicKeyBuffer(senderPublicKeyBuffer, network || Config.get('network'))
    const ecsignature = ECSignature.fromDER(signatureBuffer)

    return ecpair.verify(hash, ecsignature)
  }

  verifySecondSignature (transaction, publicKey, network) {
    const hash = this.getHash(transaction)

    const secondSignatureBuffer = Buffer.from(transaction.secondSignature, 'hex')
    const publicKeyBuffer = Buffer.from(publicKey, 'hex')
    const ecpair = ECPair.fromPublicKeyBuffer(publicKeyBuffer, network || Config.get('network'))
    const ecsignature = ECSignature.fromDER(secondSignatureBuffer)

    return ecpair.verify(hash, ecsignature)
  }

  getKeys (secret, network) {
    const ecpair = ECPair.fromSeed(secret, network || Config.get('network'))
    ecpair.publicKey = ecpair.getPublicKeyBuffer().toString('hex')
    ecpair.privateKey = ''

    return ecpair
  }

  getAddress (publicKey, version) {
    if (!version) {
      version = Config.get('pubKeyHash')
    }

    const buffer = cryptoUtils.ripemd160(Buffer.from(publicKey, 'hex'))
    const payload = Buffer.alloc(21)

    payload.writeUInt8(version, 0)
    buffer.copy(payload, 1)

    return bs58check.encode(payload)
  }

  validateAddress (address, version) {
    if (!version) {
      version = Config.get('pubKeyHash')
    }
    try {
      var decode = bs58check.decode(address)
      return decode[0] === version
    } catch (e) {
      return false
    }
  }
}

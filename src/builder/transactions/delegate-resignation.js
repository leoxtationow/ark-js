import feeManager from '@/managers/fee'
import crypto from '@/builder/crypto'
import slots from '@/crypto/slots'
import Transaction from '@/builder/transaction'
import { TRANSACTION_TYPES } from '@/constants'

export default class DelegateResignation extends Transaction {
  constructor () {
    super()

    this.id = null
    this.type = TRANSACTION_TYPES.DELEGATE_RESIGNATION
    this.fee = feeManager.get(TRANSACTION_TYPES.DELEGATE_RESIGNATION)
    this.timestamp = slots.getTime()
    this.version = 0x02
  }

  create () {
    return this
  }

  sign (passphrase) {
    const keys = crypto.getKeys(passphrase)
    this.senderPublicKey = keys.publicKey
    this.signature = crypto.sign(this, keys)
    return this
  }

  secondSign (transaction, passphrase) {
    const keys = crypto.getKeys(passphrase)
    this.secondSignature = crypto.secondSign(transaction, keys)
    return this
  }

  verify () {
    return crypto.verify(this)
  }

  serialise () {
    return {
      hex: crypto.getBytes(this).toString('hex'),
      id: crypto.getId(this),
      signature: this.signature,
      secondSignature: this.secondSignature,
      timestamp: this.timestamp,

      type: this.type,
      fee: this.fee,
      senderPublicKey: this.senderPublicKey
    }
  }
}

import feeManager from '@/managers/fee'
import configManager from '@/managers/config'
import cryptoBuilder from '@/builder/crypto'
import slots from '@/crypto/slots'
import Transaction from '@/builder/transaction'
import Model from '@/models/transaction'
import { TRANSACTION_TYPES } from '@/constants'

export default class SecondSignature extends Transaction {
  /**
   * @constructor
   * @return {[type]} [description]
   */
  constructor () {
    super()

    this.model = Model

    this.id = null
    this.type = TRANSACTION_TYPES.SECOND_SIGNATURE
    this.fee = feeManager.get(TRANSACTION_TYPES.SECOND_SIGNATURE)
    this.amount = 0
    this.timestamp = slots.getTime()
    this.recipientId = null
    this.senderPublicKey = null
    this.asset = { signature: {} }
    this.version = 0x02
    this.network = configManager.get('pubKeyHash')
  }

  /**
   * [sign description]
   * Overrides the inherited `sign` method to include the generatedd second
   * signature
   * @param  {String} passphrase [description]
   * @return {[type]}            [description]
   */
  sign (passphrase) {
    const keys = cryptoBuilder.getKeys(passphrase)
    this.senderPublicKey = keys.publicKey
    this.signature = cryptoBuilder.sign(this, keys)
    this.asset.signature = this.signature
    return this
  }

  /**
   * [getStruct description]
   * @return {[type]} [description]
   */
  getStruct () {
    return {
      hex: cryptoBuilder.getBytes(this).toString('hex'),
      id: cryptoBuilder.getId(this),
      signature: this.signature,
      secondSignature: this.secondSignature,
      timestamp: this.timestamp,

      type: this.type,
      amount: this.amount,
      fee: this.fee,
      recipientId: this.recipientId,
      senderPublicKey: this.senderPublicKey,
      asset: this.asset
    }
  }
}

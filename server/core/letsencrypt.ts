import ACME from 'acme'
import Keypairs from '@root/keypairs'
import _ from 'lodash'
import moment from 'moment'
import CSR from '@root/csr'
import PEM from '@root/pem'
import { domainToASCII } from 'node:url'
import type { AcmeAccount, AcmeCertificate, AcmeChallenge, AcmeClient } from 'acme'
import type { RootKeypair } from '@root/keypairs'

interface LetsEncryptConfig {
  account?: AcmeAccount
  accountKeypair?: RootKeypair
  challenge?: AcmeChallenge | null
  domain?: string
  payload?: AcmeCertificate
  serverKey?: string
}
interface WikiContext {
  dev?: boolean
  version: string
  config: {
    letsencrypt: LetsEncryptConfig
    maintainerEmail: string
    ssl: { domain: string; subscriberEmail: string; format?: string; inline?: boolean; key?: string; cert?: string; passphrase?: null; dhparam?: null }
  }
  configSvc: { saveToDb(keys: string[]): Promise<boolean> }
  logger: { debug(message: string): void; info(message: string): void; warn(message: string): void }
}
interface LetsEncryptService {
  acme: AcmeClient | null
  apiDirectory: string
  init(): Promise<void>
  requestCertificate(): Promise<void>
}
const wiki = WIKI as unknown as WikiContext

const letsencrypt: LetsEncryptService = {
  apiDirectory: wiki.dev ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : 'https://acme-v02.api.letsencrypt.org/directory',
  acme: null,
  async init () {
    if (!wiki.config.letsencrypt.payload) {
      await this.requestCertificate()
    } else if (wiki.config.letsencrypt.domain !== wiki.config.ssl.domain) {
      wiki.logger.info(`(LETSENCRYPT) Domain has changed. Requesting new certificates...`)
      await this.requestCertificate()
    } else if (moment(wiki.config.letsencrypt.payload.expires).isSameOrBefore(moment().add(5, 'days'))) {
      wiki.logger.info(`(LETSENCRYPT) Certificate is about to or has expired, requesting a new one...`)
      await this.requestCertificate()
    } else {
      wiki.logger.info(`(LETSENCRYPT) Using existing certificate for ${wiki.config.ssl.domain}, expires on ${wiki.config.letsencrypt.payload.expires}: [ OK ]`)
    }
    const { payload, serverKey } = wiki.config.letsencrypt
    if (!payload || !serverKey) {
      throw new Error(`Let's Encrypt certificate data is incomplete`)
    }
    wiki.config.ssl.format = 'pem'
    wiki.config.ssl.inline = true
    wiki.config.ssl.key = serverKey
    wiki.config.ssl.cert = payload.cert + '\n' + payload.chain
    wiki.config.ssl.passphrase = null
    wiki.config.ssl.dhparam = null
  },
  async requestCertificate () {
    try {
      wiki.logger.info(`(LETSENCRYPT) Initializing Let's Encrypt client...`)
      const acme = ACME.create({
        maintainerEmail: wiki.config.maintainerEmail,
        packageAgent: `tsfranki/${wiki.version}`,
        notify: (ev, msg) => {
          if (_.includes(['warning', 'error'], ev)) {
            wiki.logger.warn(`${ev}: ${String(msg)}`)
          } else {
            const serialized = JSON.stringify(msg)
            wiki.logger.debug(`${ev}: ${serialized ?? String(msg)}`)
          }
        }
      })
      this.acme = acme

      await acme.init(this.apiDirectory)

      // -> Create ACME Subscriber account

      if (!_.get(wiki.config, 'letsencrypt.account', false)) {
        wiki.logger.info(`(LETSENCRYPT) Setting up account for the first time...`)
        const accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' })
        const account = await acme.accounts.create({
          subscriberEmail: wiki.config.ssl.subscriberEmail,
          agreeToTerms: true,
          accountKey: accountKeypair.private
        })
        wiki.config.letsencrypt = {
          accountKeypair,
          account,
          domain: wiki.config.ssl.domain
        }
        await wiki.configSvc.saveToDb(['letsencrypt'])
        wiki.logger.info(`(LETSENCRYPT) Account was setup successfully [ OK ]`)
      }

      // -> Create Server Keypair

      let serverKeyPem = wiki.config.letsencrypt.serverKey
      if (!serverKeyPem) {
        wiki.logger.info(`(LETSENCRYPT) Generating server keypairs...`)
        const serverKeypair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' })
        serverKeyPem = await Keypairs.export({ jwk: serverKeypair.private })
        wiki.config.letsencrypt.serverKey = serverKeyPem
        wiki.logger.info(`(LETSENCRYPT) Server keypairs generated successfully [ OK ]`)
      }

      // -> Create CSR

      wiki.logger.info(`(LETSENCRYPT) Generating certificate signing request (CSR)...`)
      const asciiDomain = domainToASCII(wiki.config.ssl.domain)
      if (!asciiDomain) throw new Error('SSL domain is invalid')
      const domains = [asciiDomain]
      const serverKey = await Keypairs.import({ pem: serverKeyPem })
      const csrDer = await CSR.csr({ jwk: serverKey, domains, encoding: 'der' })
      const csr = PEM.packBlock({ type: 'CERTIFICATE REQUEST', bytes: csrDer })
      wiki.logger.info(`(LETSENCRYPT) CSR generated successfully [ OK ]`)

      // -> Verify Domain + Get Certificate

      wiki.logger.info(`(LETSENCRYPT) Requesting certificate from Let's Encrypt...`)
      const { account, accountKeypair } = wiki.config.letsencrypt
      if (!account || !accountKeypair) {
        throw new Error(`Let's Encrypt account data is incomplete`)
      }
      const certResp = await acme.certificates.create({
        account,
        accountKey: accountKeypair.private,
        csr,
        domains,
        challenges: {
          'http-01': {
            init () {},
            set (data) {
              wiki.logger.info(`(LETSENCRYPT) Setting HTTP challenge for ${data.challenge.hostname}: [ READY ]`)
              wiki.config.letsencrypt.challenge = data.challenge
              wiki.logger.info(`(LETSENCRYPT) Waiting for challenge to complete...`)
              return null // <- this is needed, cannot be undefined
            },
            get (data) {
              void data
              return wiki.config.letsencrypt.challenge
            },
            async remove (data) {
              void data
              wiki.logger.info(`(LETSENCRYPT) Removing HTTP challenge: [ OK ]`)
              wiki.config.letsencrypt.challenge = null
              return null // <- this is needed, cannot be undefined
            }
          }
        }
      })
      wiki.logger.info(`(LETSENCRYPT) New certificate received successfully: [ COMPLETED ]`)
      wiki.config.letsencrypt.payload = certResp
      wiki.config.letsencrypt.domain = wiki.config.ssl.domain
      await wiki.configSvc.saveToDb(['letsencrypt'])
    } catch (err) {
      wiki.logger.warn(`(LETSENCRYPT) ${err}`)
      throw err
    }
  }
}

export default letsencrypt

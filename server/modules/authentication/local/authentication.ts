import { asError, wiki, type AuthenticationPlugin, type WikiUser } from '../../types.ts'
import bcrypt from 'bcryptjs-then'


// ------------------------------------
// Local Account
// ------------------------------------

import passportLocalModule from 'passport-local'
const LocalStrategy = passportLocalModule.Strategy

interface PasswordUser extends WikiUser {
  verifyPassword(password: string): Promise<void>
}

const canVerifyPassword = (user: WikiUser): user is PasswordUser => (
  typeof user.verifyPassword === 'function'
)

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    void conf
    passport.use('local',
      new LocalStrategy({
        usernameField: 'email',
        passwordField: 'password'
      }, async (uEmail, uPassword, done) => {
        try {
          const user = await wiki.models.users.query().findOne({
            email: uEmail.toLowerCase(),
            providerKey: 'local'
          })
          if (user) {
            if (!canVerifyPassword(user)) {
              throw new Error('Local user does not support password verification.')
            }
            await user.verifyPassword(uPassword)
            if (!user.isActive) {
              done(new wiki.Error.AuthAccountBanned())
            } else if (!user.isVerified) {
              done(new wiki.Error.AuthAccountNotVerified())
            } else {
              done(null, user)
            }
          } else {
            // Fake verify password to mask timing differences
            await bcrypt.compare((Math.random() + 1).toString(36), '$2a$12$irXbAcQSY59pcQQfNQpY8uyhfSw48nzDikAmr60drI501nR.PuBx2')

            done(new wiki.Error.AuthLoginFailed())
          }
        } catch (err: unknown) {
          done(asError(err))
        }
      })
    )
  }
}

export default plugin

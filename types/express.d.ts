import type { AuthUser } from '../shared/domain.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
      isAuthenticated?: boolean
      csrfSecret?: string
    }

    interface Response {
      flush?: () => void
    }
  }
}

export {}

import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Wrap async route handlers to catch errors
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

// Standardized error response codes
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  CSRF_INVALID: 'CSRF_INVALID',
  DATABASE_ERROR: 'DATABASE_ERROR',
  TIMEOUT: 'TIMEOUT'
}

// Standardized error response format
export const sendError = (res: Response, statusCode: number, message: string, code: string | null = null, details: unknown = null) => {
  const response: Record<string, unknown> = {
    success: false,
    error: message,
    code: code || (statusCode === 400 ? ErrorCodes.BAD_REQUEST :
                   statusCode === 401 ? ErrorCodes.UNAUTHORIZED :
                   statusCode === 403 ? ErrorCodes.FORBIDDEN :
                   statusCode === 404 ? ErrorCodes.NOT_FOUND :
                   statusCode === 409 ? ErrorCodes.CONFLICT :
                   statusCode === 429 ? ErrorCodes.RATE_LIMITED :
                   ErrorCodes.INTERNAL_ERROR)
  }

  if (details) {
    response.details = details
  }

  return res.status(statusCode).json(response)
}

// Standardized success response format
export const sendSuccess = (res: Response, data: unknown = null, message: string | null = null, statusCode = 200) => {
  const response: Record<string, unknown> = { success: true }

  if (message) {
    response.message = message
  }

  if (data !== null) {
    response.data = data
  }

  return res.status(statusCode).json(response)
}

// Request timeout middleware factory (Express 5 compatible)
// Replaces deprecated req.setTimeout()/res.setTimeout() with
// socket-level timeout handling. Express 5 removed the deprecated
// methods and this approach works across Express 4 and 5.
export const createTimeoutMiddleware = (timeoutMs = 30000): RequestHandler => {
  return (req, res, next) => {
    const socket = req.socket
    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => {
      if (!res.headersSent) {
        sendError(res, 408, 'Request timeout', ErrorCodes.TIMEOUT)
        socket.destroy()
      }
    })

    next()
  }
}

// Wrap async route handlers to catch errors
export const asyncHandler = (fn) => {
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
export const sendError = (res, statusCode, message, code = null, details = null) => {
  const response = {
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
export const sendSuccess = (res, data = null, message = null, statusCode = 200) => {
  const response = { success: true }
  
  if (message) {
    response.message = message
  }
  
  if (data !== null) {
    response.data = data
  }
  
  return res.status(statusCode).json(response)
}

// Request timeout middleware factory
export const createTimeoutMiddleware = (timeoutMs = 30000) => {
  return (req, res, next) => {
    // Set timeout for the request
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        sendError(res, 408, 'Request timeout', ErrorCodes.TIMEOUT)
      }
    })
    
    // Also set response timeout
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        sendError(res, 408, 'Response timeout', ErrorCodes.TIMEOUT)
      }
    })
    
    next()
  }
}

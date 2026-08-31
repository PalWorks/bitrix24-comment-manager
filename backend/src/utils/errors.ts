export interface ErrorResponse {
    error: {
        code: string;
        message: string;
        retry_after_seconds?: number;
    };
}

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly retryAfterSeconds?: number;

    constructor(statusCode: number, code: string, message: string, retryAfterSeconds?: number) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
        Object.setPrototypeOf(this, AppError.prototype);
    }

    toResponse(): ErrorResponse {
        const response: ErrorResponse = {
            error: {
                code: this.code,
                message: this.message,
            },
        };
        if (this.retryAfterSeconds !== undefined) {
            response.error.retry_after_seconds = this.retryAfterSeconds;
        }
        return response;
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required.') {
        super(401, 'UNAUTHORIZED', message);
        this.name = 'UnauthorizedError';
        Object.setPrototypeOf(this, UnauthorizedError.prototype);
    }
}

export class ForbiddenError extends AppError {
    constructor(message = 'Access denied.') {
        super(403, 'FORBIDDEN', message);
        this.name = 'ForbiddenError';
        Object.setPrototypeOf(this, ForbiddenError.prototype);
    }
}

export class NotFoundError extends AppError {
    constructor(message = 'Resource not found.') {
        super(404, 'NOT_FOUND', message);
        this.name = 'NotFoundError';
        Object.setPrototypeOf(this, NotFoundError.prototype);
    }
}

export class BadRequestError extends AppError {
    constructor(message = 'Invalid request.') {
        super(400, 'BAD_REQUEST', message);
        this.name = 'BadRequestError';
        Object.setPrototypeOf(this, BadRequestError.prototype);
    }
}

export class RateLimitedError extends AppError {
    constructor(retryAfterSeconds: number, message = 'Rate limit exceeded.') {
        super(429, 'RATE_LIMITED', message, retryAfterSeconds);
        this.name = 'RateLimitedError';
        Object.setPrototypeOf(this, RateLimitedError.prototype);
    }
}

export class DuplicateError extends AppError {
    constructor(message = 'Duplicate content detected.') {
        super(409, 'DUPLICATE', message);
        this.name = 'DuplicateError';
        Object.setPrototypeOf(this, DuplicateError.prototype);
    }
}

export class InternalError extends AppError {
    constructor(message = 'Internal server error.') {
        super(500, 'INTERNAL_ERROR', message);
        this.name = 'InternalError';
        Object.setPrototypeOf(this, InternalError.prototype);
    }
}

export class BitrixApiError extends AppError {
    constructor(message = 'Bitrix24 API error.') {
        super(502, 'BITRIX_ERROR', message);
        this.name = 'BitrixApiError';
        Object.setPrototypeOf(this, BitrixApiError.prototype);
    }
}

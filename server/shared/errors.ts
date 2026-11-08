export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: FieldError[] | undefined;
  readonly isOperational: boolean;

  constructor(message: string, code: string, status: number, details?: FieldError[]) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.isOperational = true;
  }
}

export class BadRequestError extends AppError {
  constructor(message = '请求参数不合法') {
    super(message, 'BAD_REQUEST', 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '请先登录') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '没有操作权限') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} 不存在` : `${resource}不存在`, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

export class ValidationError extends AppError {
  constructor(details: FieldError[], message = '输入校验失败') {
    super(message, 'VALIDATION_ERROR', 422, details);
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, status = 502) {
    super(message, 'UPSTREAM_ERROR', status);
  }
}

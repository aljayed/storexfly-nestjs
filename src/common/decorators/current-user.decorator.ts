import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal, RequestWithPrincipal } from '../types/principal';

/**
 * Injects the authenticated principal (or one of its fields) into a handler.
 *   `@CurrentUser() user: SellerPrincipal`
 *   `@CurrentUser('id') userId: string`
 */
export const CurrentUser = createParamDecorator(
  (data: keyof Principal | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);

import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ChatActor, RequestWithChatActor } from './chat-actor';
import { ChatTokenService } from './chat-token.service';

const CHAT_ROLE_KEY = 'chatRole';

/** Restrict a chat route to one side, e.g. `@ChatRole('seller')`. */
export const ChatRole = (role: ChatActor['role']) =>
  SetMetadata(CHAT_ROLE_KEY, role);

/** Injects the verified chat participant into a handler. */
export const CurrentChatActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ChatActor =>
    ctx.switchToHttp().getRequest<RequestWithChatActor>().chatActor,
);

/**
 * Bearer-token guard for chat REST routes. Accepts either platform session
 * kind via ChatTokenService and attaches the resolved actor to the request.
 * Chat controllers are marked @Public() to opt out of the global seller-JWT
 * guard, then protected by this one - same pattern the reviews module uses
 * with the buyer guard.
 */
@Injectable()
export class ChatAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: ChatTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithChatActor>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const actor = await this.tokens.verify(token);

    const required = this.reflector.getAllAndOverride<
      ChatActor['role'] | undefined
    >(CHAT_ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (required && actor.role !== required) {
      throw new ForbiddenException(`This chat route is ${required}-only`);
    }

    request.chatActor = actor;
    return true;
  }
}

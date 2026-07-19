import type { PluginSDK } from '../../main/plugins/sdk';
import { normalizeWeiboText, type WeiboComment, type WeiboPost } from './model';

export const WEIBO_COLLECTIONS = {
  orgConfig: 'weibo_org_config',
  posts: 'weibo_posts',
  comments: 'weibo_comments'
} as const;

export type WeiboOrgConfig = {
  orgId: string;
  superAdminRootId: string;
  createdBy: string;
  createdAt: number;
};

type WeiboAuthorRole = 'admin' | 'member' | null | undefined;

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export class WeiboCoreService {
  constructor(private readonly sdk: PluginSDK) {}

  async ensureOrgConfig(orgId: string, rootId: string): Promise<WeiboOrgConfig> {
    const existing = await this.sdk.docs.get<WeiboOrgConfig>(WEIBO_COLLECTIONS.orgConfig, orgId);
    if (existing) {
      return existing;
    }

    const created: WeiboOrgConfig = {
      orgId,
      superAdminRootId: rootId,
      createdBy: rootId,
      createdAt: Date.now()
    };

    await this.sdk.docs.put(WEIBO_COLLECTIONS.orgConfig, orgId, created as unknown as Record<string, unknown>);
    return created;
  }

  async createPost(orgId: string, rootId: string, content: string, authorRole: WeiboAuthorRole): Promise<WeiboPost> {
    if (authorRole !== 'admin') {
      throw new Error('Only organization admins can publish posts');
    }

    const post: WeiboPost = {
      id: newId('post'),
      orgId,
      content: normalizeWeiboText(content),
      authorRootId: rootId,
      createdAt: Date.now()
    };

    await this.sdk.docs.put(WEIBO_COLLECTIONS.posts, post.id, post as unknown as Record<string, unknown>);
    return post;
  }

  async createComment(orgId: string, postId: string, rootId: string, content: string, parentCommentId?: string): Promise<WeiboComment> {
    const comment: WeiboComment = {
      id: newId('comment'),
      orgId,
      postId,
      parentCommentId,
      content: normalizeWeiboText(content),
      authorRootId: rootId,
      createdAt: Date.now()
    };

    await this.sdk.docs.put(WEIBO_COLLECTIONS.comments, comment.id, comment as unknown as Record<string, unknown>);
    return comment;
  }

  async loadPosts(orgId: string): Promise<WeiboPost[]> {
    const response = await this.sdk.docs.query<WeiboPost>(WEIBO_COLLECTIONS.posts, {
      filter: [{ field: 'orgId', value: orgId }],
      reverse: true,
      limit: 500
    });

    return response.items.map((item) => item.data).sort((a, b) => b.createdAt - a.createdAt);
  }

  async loadComments(orgId: string): Promise<WeiboComment[]> {
    const response = await this.sdk.docs.query<WeiboComment>(WEIBO_COLLECTIONS.comments, {
      filter: [{ field: 'orgId', value: orgId }],
      reverse: false,
      limit: 2000
    });

    return response.items.map((item) => item.data).sort((a, b) => a.createdAt - b.createdAt);
  }
}

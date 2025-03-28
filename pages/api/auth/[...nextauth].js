import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcrypt";
import { supabase } from "../../../lib/supabase";
import { userOperations } from "../../../lib/db";

// 自定义 QQ OAuth Provider
const QQProvider = {
  id: "qq",
  name: "QQ",
  type: "oauth",
  wellKnown: "https://graph.qq.com/.well-known/openid-configuration",
  authorization: {
    url: "https://graph.qq.com/oauth2.0/authorize",
    params: { scope: "get_user_info" },
  },
  token: {
    url: "https://graph.qq.com/oauth2.0/token",
    async request({ provider, params, client }) {
      const response = await fetch(`${provider.token.url}?${new URLSearchParams({
        ...params,
        format: "json",
        grant_type: "authorization_code",
      })}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      
      const tokens = await response.json();
      
      // 获取 OpenID
      const openIdResponse = await fetch(`https://graph.qq.com/oauth2.0/me?access_token=${tokens.access_token}&format=json`);
      const openIdData = await openIdResponse.json();
      
      return {
        tokens: {
          ...tokens,
          id_token: openIdData.openid,
        },
      };
    },
  },
  userinfo: {
    url: "https://graph.qq.com/user/get_user_info",
    async request({ provider, tokens }) {
      const response = await fetch(`${provider.userinfo.url}?${new URLSearchParams({
        access_token: tokens.access_token,
        oauth_consumer_key: process.env.QQ_CLIENT_ID,
        openid: tokens.id_token,
      })}`);

      const profile = await response.json();
      
      return {
        id: tokens.id_token,
        name: profile.nickname,
        email: `${tokens.id_token}@qq.com`, // QQ doesn't provide email, so we create a fake one
        image: profile.figureurl_qq_2 || profile.figureurl_qq_1,
      };
    },
  },
  clientId: process.env.QQ_CLIENT_ID,
  clientSecret: process.env.QQ_CLIENT_SECRET,
};

export const authOptions = {
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "账号密码",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" }
      },
      async authorize(credentials) {
        // 验证凭据是否存在
        if (!credentials?.email || !credentials?.password) {
          throw new Error("请提供邮箱和密码");
        }

        try {
          // 使用自定义函数获取用户
          const user = await userOperations.getUserByEmail(credentials.email);

          // 验证用户是否存在
          if (!user) {
            console.log(`用户不存在: ${credentials.email}`);
            throw new Error("邮箱或密码不正确");
          }

          // 验证用户是否有密码
          if (!user.password) {
            console.log(`用户没有密码: ${credentials.email}`);
            throw new Error("账号验证失败，请使用其他登录方式");
          }

          // 验证密码
          const isPasswordValid = await compare(
            credentials.password,
            user.password
          );

          // 密码不正确
          if (!isPasswordValid) {
            console.log(`密码不正确: ${credentials.email}`);
            throw new Error("邮箱或密码不正确");
          }

          // 登录成功，返回用户信息
          console.log(`用户登录成功: ${user.email} (${user.name})`);
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            role: user.role
          };
        } catch (error) {
          console.error("登录验证失败:", error.message);
          throw new Error(error.message || "登录失败，请稍后再试");
        }
      }
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    QQProvider,
  ],
  cookies: {
    sessionToken: {
      name: `next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: false, // 开发环境中设置为 false，确保 cookie 可以在任何环境下工作
        maxAge: 30 * 24 * 60 * 60, // 30 days
      },
    },
    callbackUrl: {
      name: `next-auth.callback-url`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: false,
      },
    },
    csrfToken: {
      name: `next-auth.csrf-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: false,
      },
    },
  },
  session: {
    strategy: "jwt", // 使用JWT策略存储会话
    maxAge: 30 * 24 * 60 * 60, // 30天
    updateAge: 24 * 60 * 60, // 每24小时刷新会话
  },
  jwt: {
    secret: process.env.NEXTAUTH_SECRET,
    maxAge: 30 * 24 * 60 * 60, // 30天
    encryption: true, // 启用加密
  },
  debug: process.env.NEXTAUTH_DEBUG === "true",
  // 自定义错误信息（中文）
  theme: {
    error: '出错了',
    logo: 'TransferWiki.cc',
    brandColor: '#4a90e2',
  },
  errors: {
    configuration: '认证系统配置错误',
    accessdenied: '访问被拒绝',
    verification: '验证链接无效或已过期',
  },
  callbacks: {
    async jwt({ token, user, account }) {
      // 初次登录时，将用户信息添加到JWT
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      // 从JWT传递数据到session
      if (token) {
        session.user.id = token.id;
        session.user.role = token.role;
      }
      return session;
    },
    async signIn({ user, account }) {
      try {
        // 如果是使用OAuth登录
        if (account && account.provider !== "credentials") {
          // 检查用户是否已存在
          const existingUser = await userOperations.getUserByEmail(user.email);
          
          if (!existingUser) {
            // 创建新用户
            await userOperations.createUser({
              name: user.name,
              email: user.email,
              image: user.image,
              role: "USER",
            });
          }
          
          // 检查是否为指定的管理员邮箱
          const adminEmails = process.env.ADMIN_EMAILS?.split(",") || [];
          if (user.email && adminEmails.includes(user.email)) {
            if (existingUser) {
              await userOperations.updateUser(existingUser.id, { role: "ADMIN" });
            }
            user.role = "ADMIN";
          }
        }
        
        return true;
      } catch (error) {
        console.error("Error in signIn callback:", error);
        return true; // 继续登录流程，即使出现错误
      }
    },
  },
  pages: {
    signIn: "/login",
    signUp: "/register",
    error: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
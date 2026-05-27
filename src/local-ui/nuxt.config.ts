import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  compatibilityDate: "2026-05-27",
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: true },
  ui: {
    colorMode: false,
    theme: {
      defaultVariants: {
        color: "neutral",
        size: "sm"
      }
    }
  },
  runtimeConfig: {
    public: {
      apiBase: process.env.DOXVELT_API_BASE || "http://127.0.0.1:8787"
    }
  },
  vite: {
    optimizeDeps: {
      include: [
        "@vue/devtools-core",
        "@vue/devtools-kit"
      ]
    }
  }
});

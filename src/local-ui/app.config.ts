export default defineAppConfig({
  ui: {
    colors: {
      primary: "primary",
      success: "success",
      info: "info",
      warning: "warning",
      error: "error",
      neutral: "neutral"
    },
    button: {
      slots: {
        base: "dx-button rounded-sm"
      },
      defaultVariants: {
        color: "neutral",
        size: "sm"
      }
    },
    badge: {
      slots: {
        base: "rounded-full font-medium !ring-0"
      },
      defaultVariants: {
        color: "neutral",
        variant: "soft",
        size: "sm"
      }
    },
    card: {
      slots: {
        root: "dx-card rounded-md",
        body: "p-4 sm:p-4",
        header: "p-4 sm:px-4",
        footer: "p-4 sm:px-4"
      }
    },
    formField: {
      slots: {
        container: "dx-field-container",
        label: "dx-field-label",
        help: "text-muted",
        hint: "text-muted"
      },
      defaultVariants: {
        size: "xs"
      }
    },
    input: {
      slots: {
        root: "dx-field-shell rounded-sm",
        base: "dx-field-input placeholder:text-dimmed"
      },
      defaultVariants: {
        color: "primary",
        variant: "outline",
        size: "sm"
      }
    },
    select: {
      slots: {
        base: "dx-field-shell rounded-sm"
      },
      defaultVariants: {
        color: "primary",
        variant: "outline",
        size: "sm"
      }
    },
    textarea: {
      slots: {
        root: "dx-field-shell rounded-sm",
        base: "dx-field-input placeholder:text-dimmed"
      },
      defaultVariants: {
        color: "primary",
        variant: "outline",
        size: "sm"
      }
    },
    tabs: {
      slots: {
        list: "rounded-sm bg-muted !ring-0 border border-muted",
        indicator: "hidden",
        trigger: "rounded-sm data-[state=active]:!bg-default data-[state=active]:!text-highlighted"
      },
      defaultVariants: {
        color: "neutral",
        variant: "pill",
        size: "sm"
      }
    },
    pageHero: {
      slots: {
        title: "font-normal tracking-normal text-highlighted",
        description: "text-muted"
      }
    },
    pageCard: {
      slots: {
        root: "dx-card rounded-md",
        title: "text-highlighted",
        description: "text-muted"
      }
    }
  }
});

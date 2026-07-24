import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  route("/login", "routes/login.tsx"),
  route("/signup", "routes/signup.tsx"),
  route("/logout", "routes/logout.tsx"),

  index("routes/home.tsx"),
  route("setup", "routes/setup.tsx"),
  route("/forms", "routes/forms.tsx", [
    route(":formId", "routes/forms.$formId.tsx", [
      route("submissions", "routes/forms.$formId.submissions.tsx"),
      route("submissions/:submissionId", "routes/forms.$formId.submissions.$submissionId.tsx"),
      route(
        "submissions/:submissionId/files/:fileId",
        "routes/forms.$formId.submissions.$submissionId.files.$fileId.tsx"
      ),
      route(
        "submissions/export",
        "routes/forms.$formId.submissions.export.tsx"
      ),
      route("integration", "routes/forms.$formId.integration.tsx"),
      route("settings", "routes/forms.$formId.settings.tsx", [
        index("routes/forms.$formId.settings.general.tsx"),
        route("fields", "routes/forms.$formId.settings.fields.tsx"),
        route("security", "routes/forms.$formId.settings.security.tsx"),
        route(
          "notifications",
          "routes/forms.$formId.settings.notifications.tsx"
        ),
        route("webhooks", "routes/forms.$formId.settings.webhooks.tsx"),
        route("uploads", "routes/forms.$formId.settings.uploads.tsx"),
        route("retention", "routes/forms.$formId.settings.retention.tsx"),
        route("advanced", "routes/forms.$formId.settings.advanced.tsx"),
      ]),
    ]),
  ]),
  route("settings/notifications", "routes/settings.notifications.tsx"),
  route("settings/notifications/test", "routes/settings.notifications.test.tsx"),

  route("/api/auth/*", "routes/api.auth.$.tsx"),
  route("/api/forms/:formId/submissions", "routes/api.forms.$formId.submissions.tsx"),
  route("/api/forms/:formId/public-config", "routes/api.forms.$formId.public-config.tsx"),
  route("/api/forms/:formId/uploads", "routes/api.forms.$formId.uploads.tsx"),
  route(
    "/api/forms/:formId/uploads/:sessionId/files/:fileId",
    "routes/api.forms.$formId.uploads.$sessionId.files.$fileId.tsx"
  ),
  route(
    "/api/forms/:formId/uploads/:sessionId/complete",
    "routes/api.forms.$formId.uploads.$sessionId.complete.tsx"
  ),

  route("/success", "routes/success.tsx"),
  route("/error", "routes/error.tsx"),
] satisfies RouteConfig;

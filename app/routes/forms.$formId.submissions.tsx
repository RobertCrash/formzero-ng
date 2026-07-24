import { useMemo } from "react"
import { Link, useFetcher, useLoaderData } from "react-router"
import type { Route } from "./+types/forms.$formId.submissions"
import { createColumns } from "./forms.$formId.submissions/columns"
import type { Submission } from "./forms.$formId.submissions/columns"
import { DataTable } from "./forms.$formId.submissions/data-table"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "~/components/ui/chart"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Inbox, TrendingUp, TrendingDown, Download } from "lucide-react"
import type { ChartConfig } from "~/components/ui/chart"
import { requireAuth } from "~/lib/require-auth.server"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import type { FieldRule } from "~/lib/form-config/types"

export const meta: Route.MetaFunction = () => {
  return [
    { title: `Submissions | FormZero` },
    { name: "description", content: "View and manage form submissions" },
  ];
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { formId } = params
  const database = context.cloudflare.env.DB

  await requireAuth(request, database)
  const form = await loadFormWithPolicy(database, formId)
  if (!form) throw new Response("Form not found", { status: 404 })

  const url = new URL(request.url)
  const rawCursor = url.searchParams.get("cursor")
  const [cursorCreatedAt, cursorId] = rawCursor?.split(".", 2) ?? []
  const hasCursor =
    cursorCreatedAt !== undefined &&
    /^\d+$/.test(cursorCreatedAt) &&
    Boolean(cursorId)
  const pageSize = 50
  const now = Date.now()
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000
  const twoMonthsAgo = now - 60 * 24 * 60 * 60 * 1000

  const statsPromise = database
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS this_week,
        SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END)
          AS previous_week,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS this_month,
        SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END)
          AS previous_month
      FROM submissions
      WHERE form_id = ?
        AND status = 'accepted'
    `)
    .bind(
      oneWeekAgo,
      twoWeeksAgo,
      oneWeekAgo,
      oneMonthAgo,
      twoMonthsAgo,
      oneMonthAgo,
      formId
    )
    .first<{
      total: number
      this_week: number
      previous_week: number
      this_month: number
      previous_month: number
    }>()

  const chartPromise = database
    .prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') AS day,
        COUNT(*) AS count
      FROM submissions
      WHERE form_id = ?
        AND status = 'accepted'
        AND created_at >= ?
      GROUP BY day
      ORDER BY day
    `)
    .bind(formId, now - 29 * 24 * 60 * 60 * 1000)
    .all<{ day: string; count: number }>()

  const listSql = `
    SELECT id, form_id, data, created_at
    FROM submissions
    WHERE form_id = ?
      AND status != 'pending_delete'
      ${
        hasCursor
          ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
          : ""
      }
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `
  const listStatement = database.prepare(listSql)
  const listPromise = (
    hasCursor
      ? listStatement.bind(
          formId,
          Number(cursorCreatedAt),
          Number(cursorCreatedAt),
          cursorId,
          pageSize + 1
        )
      : listStatement.bind(formId, pageSize + 1)
  ).all<{ id: string; form_id: string; data: string; created_at: number }>()

  const exportPromise = database
    .prepare(`
      SELECT id, status, row_count, last_error, created_at
      FROM export_jobs
      WHERE form_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `)
    .bind(formId)
    .all<{
      id: string
      status: string
      row_count: number | null
      last_error: string | null
      created_at: number
    }>()

  const [statsRow, chartRows, submissionRows, exportRows] = await Promise.all([
    statsPromise,
    chartPromise,
    listPromise,
    exportPromise,
  ])
  const statsData = statsRow ?? {
    total: 0,
    this_week: 0,
    previous_week: 0,
    this_month: 0,
    previous_month: 0,
  }
  const thisWeek = statsData.this_week ?? 0
  const previousWeek = statsData.previous_week ?? 0
  const thisMonth = statsData.this_month ?? 0
  const previousMonth = statsData.previous_month ?? 0
  const weekTrend = previousWeek === 0
    ? (thisWeek > 0 ? 100 : 0)
    : Math.round(((thisWeek - previousWeek) / previousWeek) * 100)
  const monthTrend = previousMonth === 0
    ? (thisMonth > 0 ? 100 : 0)
    : Math.round(((thisMonth - previousMonth) / previousMonth) * 100)

  const countsByDay = new Map(
    chartRows.results.map((row) => [row.day, Number(row.count)])
  )
  const dailySubmissions: { date: string; count: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000)
    const day = date.toISOString().slice(0, 10)
    dailySubmissions.push({
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: countsByDay.get(day) ?? 0,
    })
  }

  const hasNextPage = submissionRows.results.length > pageSize
  const pageRows = submissionRows.results.slice(0, pageSize)
  const parsedSubmissions: Submission[] = pageRows.map((row) => ({
    id: row.id,
    form_id: row.form_id,
    data: JSON.parse(row.data),
    created_at: row.created_at,
  }))
  const last = pageRows.at(-1)
  const nextCursor =
    hasNextPage && last ? `${last.created_at}.${last.id}` : null

  let fields: FieldRule[] = form.policy.fields
  if (fields.length === 0) {
    const legacyFields = await database
      .prepare(`
        SELECT DISTINCT field.key AS name
        FROM submissions AS submission,
             json_each(submission.data) AS field
        WHERE submission.form_id = ?
        ORDER BY field.key
      `)
      .bind(formId)
      .all<{ name: string }>()
    fields = legacyFields.results.map((field) => ({
      name: field.name,
      label: field.name.charAt(0).toUpperCase() + field.name.slice(1),
      type: "string",
      required: false,
    }))
  }

  return {
    formId,
    submissions: parsedSubmissions,
    fields,
    stats: {
      total: Number(statsData.total ?? 0),
      thisWeek,
      thisMonth,
      weekTrend,
      monthTrend,
    },
    chartData: dailySubmissions,
    nextCursor,
    exportJobs: exportRows.results,
  }
}

const chartConfig = {
  count: {
    label: "Submissions",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

export default function SubmissionsPage() {
  const { formId, submissions, fields, stats, chartData, nextCursor, exportJobs } =
    useLoaderData<typeof loader>()
  const exportFetcher = useFetcher<{ success?: boolean; error?: string }>()

  const columns = useMemo(() => createColumns(fields), [fields])

  return (
    <div className="flex flex-1 flex-col gap-2 min-w-0">
      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3 min-w-0">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground">Total Submissions</h3>
          <p className="text-2xl font-bold mt-1">{stats.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground">This Week</h3>
          <div className="flex items-end gap-2 mt-1">
            <p className="text-2xl font-bold">{stats.thisWeek}</p>
            <div className={`flex items-center gap-1 text-xs font-medium pb-0.5 ${stats.weekTrend > 0 ? 'text-green-600 dark:text-green-500' : stats.weekTrend < 0 ? 'text-red-600 dark:text-red-500' : 'text-muted-foreground'}`}>
              {stats.weekTrend > 0 ? <TrendingUp className="h-3 w-3" /> : stats.weekTrend < 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              <span>{stats.weekTrend > 0 ? '+' : ''}{stats.weekTrend}%</span>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground">This Month</h3>
          <div className="flex items-end gap-2 mt-1">
            <p className="text-2xl font-bold">{stats.thisMonth}</p>
            <div className={`flex items-center gap-1 text-xs font-medium pb-0.5 ${stats.monthTrend > 0 ? 'text-green-600 dark:text-green-500' : stats.monthTrend < 0 ? 'text-red-600 dark:text-red-500' : 'text-muted-foreground'}`}>
              {stats.monthTrend > 0 ? <TrendingUp className="h-3 w-3" /> : stats.monthTrend < 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              <span>{stats.monthTrend > 0 ? '+' : ''}{stats.monthTrend}%</span>
            </div>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Last 30 Days</CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <ChartContainer config={chartConfig} className="h-[140px] w-full">
            <LineChart accessibilityLayer data={chartData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                tickMargin={8}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={50}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                allowDecimals={false}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="linear"
                dataKey="count"
                stroke="var(--color-count)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {submissions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center min-w-0 py-12">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox className="h-10 w-10" />
              </EmptyMedia>
              <EmptyTitle>No submissions yet</EmptyTitle>
              <EmptyDescription>
                Get started by sendng your first submission to this form.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link to="../integration">Integrate</Link>
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={submissions}
          totalCount={stats.total}
          headerAction={
            stats.total > 5_000 ? (
              <exportFetcher.Form
                method="post"
                action={`/forms/${submissions[0].form_id}/submissions/export`}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 text-xs"
                  disabled={exportFetcher.state !== "idle"}
                >
                  <Download className="h-3 w-3" />
                  Generate CSV
                </Button>
              </exportFetcher.Form>
            ) : (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs"
              >
                <a
                  href={`/forms/${submissions[0].form_id}/submissions/export`}
                >
                  <Download className="h-3 w-3" />
                  Export CSV
                </a>
              </Button>
            )
          }
          footerAction={
            nextCursor ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`?cursor=${encodeURIComponent(nextCursor)}`}>
                  Next page
                </Link>
              </Button>
            ) : null
          }
        />
      )}
      {exportJobs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Exports</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {exportJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between gap-3">
                <span>
                  {new Date(job.created_at).toLocaleString()} · {job.status}
                  {job.row_count !== null ? ` · ${job.row_count} rows` : ""}
                  {job.last_error ? ` · ${job.last_error}` : ""}
                </span>
                {job.status === "completed" && (
                  <Button asChild size="sm" variant="outline">
                    <a
                      href={`/forms/${formId}/submissions/export?job=${job.id}`}
                    >
                      Download
                    </a>
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

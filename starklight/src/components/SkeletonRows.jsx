export default function SkeletonRows({ rows = 4 }) {
  return (
    <div className="rounded-xl border border-theme overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="skeleton h-4 w-1/3 rounded" />
          <div className="skeleton h-4 w-16 rounded ml-auto" />
        </div>
      ))}
    </div>
  )
}

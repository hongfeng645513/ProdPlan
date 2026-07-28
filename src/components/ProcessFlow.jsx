/** GO film route through the plant: carbonization first, then graphitization. */
export default function ProcessFlow({ machines, selected, onSelect }) {
  const carb = machines.filter((m) => m.function.toLowerCase().startsWith('carb'))
  const graph = machines.filter((m) => !m.function.toLowerCase().startsWith('carb'))

  const Step = ({ title, detail, list, kind }) => (
    <div className={`flow-step flow-${kind}`}>
      <h4>{title}</h4>
      <p>{detail}</p>
      <div className="flow-machines">
        {list.map((m) => (
          <button
            key={m.id}
            className={`chip${selected === m.id ? ' is-selected' : ''}`}
            onClick={() => onSelect(m.id)}
          >
            {m.name}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="flow">
      <div className="flow-step flow-material">
        <h4>GO film</h4>
        <p>Incoming graphene-oxide film</p>
      </div>
      <span className="flow-arrow" aria-hidden="true">→</span>
      <Step
        kind="carb"
        title="Carbonization"
        detail="Ramp to 1000 °C, hold, then cool naturally"
        list={carb}
      />
      <span className="flow-arrow" aria-hidden="true">→</span>
      <Step
        kind="graph"
        title="Graphitization"
        detail="Ramp to 2800 °C, hold, then cool naturally"
        list={graph}
      />
      <span className="flow-arrow" aria-hidden="true">→</span>
      <div className="flow-step flow-material">
        <h4>Graphite film</h4>
        <p>Finished product</p>
      </div>
    </div>
  )
}

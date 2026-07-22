import type { ReactNode } from 'react';
export function AdminConsole(props: {
  loading: boolean;
  dependencies: readonly { name: string; state: string }[];
}): ReactNode {
  return (
    <main>
      <h1 tabIndex={-1}>Instance administration</h1>
      <p role="status" aria-live="polite">
        {props.loading ? 'Loading administration status.' : ''}
      </p>
      <table>
        <caption>Dependency health</caption>
        <thead>
          <tr>
            <th scope="col">Dependency</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {props.dependencies.map((item) => (
            <tr key={item.name}>
              <th scope="row">{item.name}</th>
              <td>{item.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

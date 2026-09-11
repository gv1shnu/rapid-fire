import { QuestionPreview } from './QuestionPreview';
import { Instructor } from './Instructor';
import { Home } from './Home';
import { Play } from './Play';

export function App() {
  if (window.location.pathname === '/instructor') return <Instructor />;
  const params = new URLSearchParams(window.location.search);
  if (params.get('preview') === 'question') return <QuestionPreview />;
  const join = params.get('j');
  if (join) return <Play code={join} />;
  return <Home />;
}

import { QuestionPreview } from './QuestionPreview';
import { Instructor } from './Instructor';
import { Home } from './Home';

export function App() {
  if (window.location.pathname === '/instructor') return <Instructor />;
  if (
    new URLSearchParams(window.location.search).get('preview') === 'question'
  ) {
    return <QuestionPreview />;
  }
  return <Home />;
}

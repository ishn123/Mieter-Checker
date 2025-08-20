import React, { createContext, useContext, useMemo, useState } from 'react';

export const Button = ({variant, className='', ...props}: any) => <button className={`btn ${variant==='outline'?'btn-outline':''} ${className}`} {...props} />;
export const Input = (props: any) => <input className="input" {...props} />;
export const Textarea = (props: any) => <textarea className="textarea" {...props} />;
export const Label = (props: any) => <label {...props} />;
export const Badge = ({children}: any) => <span className="badge">{children}</span>;

export const Card = ({children}: any)=> <div className="card">{children}</div>;
export const CardHeader = ({children}: any)=> <div className="card-h">{children}</div>;
export const CardTitle = ({children}: any)=> <div style={{fontWeight:700}}>{children}</div>;
export const CardDescription = ({children}: any)=> <div className="muted" style={{fontSize:14}}>{children}</div>;
export const CardContent = ({children, className}: any)=> <div className={`card-c ${className||''}`}>{children}</div>;

// Tabs
const TabsCtx = createContext<any>(null);
export const Tabs = ({defaultValue, children}: any) => {
  const [value, setValue] = useState(defaultValue);
  const ctx = useMemo(()=>({value, setValue}),[value]);
  return <TabsCtx.Provider value={ctx}><div>{children}</div></TabsCtx.Provider>;
};
export const TabsList = ({children}: any) => <div className="tabs">{children}</div>;
export const TabsTrigger = ({value, children}: any) => {
  const {value: v, setValue} = useContext(TabsCtx);
  const active = v===value;
  return <button className={`tabbtn ${active?'active':''}`} onClick={()=> setValue(value)}>{children}</button>;
};
export const TabsContent = ({value, children}: any) => {
  const {value: v} = useContext(TabsCtx);
  if (v!==value) return null;
  return <div>{children}</div>;
};

// Table
export const Table = ({children, className}: any)=> <table className={`table ${className||''}`}>{children}</table>;
export const TableHeader = ({children}: any)=> <thead>{children}</thead>;
export const TableBody = ({children}: any)=> <tbody>{children}</tbody>;
export const TableRow = ({children, className}: any)=> <tr className={className}>{children}</tr>;
export const TableHead = ({children}: any)=> <th>{children}</th>;
export const TableCell = ({children, className}: any)=> <td className={className}>{children}</td>;

// Select (renders native select from SelectItem children)
const SelectCtx = createContext<any>(null);
export const Select = ({value, onValueChange, id, children}: any) => {
  const items: any[] = [];
  React.Children.forEach(children, (child: any) => {
    if (!child) return;
    if (child.type?.displayName === 'SelectContent') {
      React.Children.forEach(child.props.children, (grand: any) => {
        if (grand?.type?.displayName === 'SelectItem') {
          items.push({value: grand.props.value, label: grand.props.children});
        }
      });
    }
  });
  return (
    <select id={id? `${id}-native`: undefined} className="input" value={value} onChange={(e)=> onValueChange && onValueChange(e.target.value)}>
      <option value="" disabled>{/* placeholder */}</option>
      {items.map(it=> <option key={it.value} value={it.value}>{it.label}</option>)}
    </select>
  );
};
export const SelectTrigger = ({children}: any) => <>{children}</>;
export const SelectValue = ({placeholder}: any) => <>{placeholder||null}</>;
const SelectContentImpl = ({children}: any) => <>{children}</>;
SelectContentImpl.displayName = 'SelectContent';
export const SelectContent = SelectContentImpl;
const SelectItemImpl = ({children}: any) => <>{children}</>;
SelectItemImpl.displayName = 'SelectItem';
export const SelectItem = Object.assign(SelectItemImpl, {});
